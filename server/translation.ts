import fs from 'fs';
import path from 'path';

/*
 * ============================================================
 * SUPPORTED LANGUAGES
 * ============================================================
 */

export type SupportedTranslationLanguage =
  | 'en'
  | 'hi'
  | 'bn'
  | 'te'
  | 'mr'
  | 'ta'
  | 'gu'
  | 'kn'
  | 'ml'
  | 'pa'
  | 'or'
  | 'as'
  | 'ne'
  | 'ur';

type NonEnglishLanguage =
  Exclude<
    SupportedTranslationLanguage,
    'en'
  >;

/*
 * The frontend currently sends batches
 * of 6 strings.
 *
 * Keep the backend compatible with it.
 */
export const MAX_BATCH_SIZE = 6;

/*
 * ============================================================
 * CACHE
 * ============================================================
 */

type TranslationCache = {
  version: 2;
  sourceLanguage: 'en';

  translations: Partial<
    Record<
      NonEnglishLanguage,
      Record<string, string>
    >
  >;
};

const CACHE_FILE =
  process.env.TRANSLATION_CACHE_FILE ||
  path.resolve(
    'data',
    'translations-cache-v2.json'
  );

/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const REQUEST_TIMEOUT_MS = 8000;

/*
 * After a MyMemory failure / 429,
 * don't immediately hit the API again.
 */
const FAILURE_COOLDOWN_MS =
  60_000;

/*
 * Global provider cooldown.
 *
 * This protects Render from repeatedly
 * hitting MyMemory after a 429.
 */
const PROVIDER_COOLDOWN_MS =
  60_000;

/*
 * Only ONE MyMemory request at a time.
 *
 * The frontend already sends groups of 6.
 * There is no reason to create a burst
 * of external requests.
 */
const MAX_CONCURRENT_REQUESTS = 1;

/*
 * Maximum individual text length.
 */
const MAX_TEXT_LENGTH = 500;

/*
 * ============================================================
 * IN-MEMORY STATE
 * ============================================================
 */

/*
 * Cache loaded from disk.
 */
let cache: TranslationCache | null =
  null;

/*
 * Same text + same language already
 * being requested.
 *
 * Example:
 *
 * "Apply Now" + "ne"
 *
 * requested 10 times at the same time
 * = only ONE MyMemory request.
 */
const pendingRequests =
  new Map<
    string,
    Promise<string>
  >();

/*
 * Requests which recently failed.
 */
const failedUntil =
  new Map<
    string,
    number
  >();

/*
 * Global MyMemory cooldown.
 */
let providerBlockedUntil = 0;

/*
 * Queue.
 */
type QueueItem = {
  key: string;
  text: string;
  language: NonEnglishLanguage;

  resolve: (
    value: string
  ) => void;

  reject: (
    reason?: unknown
  ) => void;
};

const requestQueue: QueueItem[] =
  [];

/*
 * Number of currently running
 * MyMemory requests.
 */
let activeRequests = 0;

/*
 * ============================================================
 * CACHE HELPERS
 * ============================================================
 */

function createEmptyCache(): TranslationCache {
  return {
    version: 2,
    sourceLanguage: 'en',
    translations: {},
  };
}

function loadCache(): TranslationCache {
  if (cache) {
    return cache;
  }

  try {
    if (
      !fs.existsSync(
        CACHE_FILE
      )
    ) {
      cache =
        createEmptyCache();

      return cache;
    }

    const raw =
      fs.readFileSync(
        CACHE_FILE,
        'utf8'
      );

    const parsed =
      JSON.parse(
        raw
      ) as Partial<TranslationCache>;

    if (
      parsed.version !== 2 ||
      parsed.sourceLanguage !==
        'en' ||
      !parsed.translations ||
      typeof parsed.translations !==
        'object'
    ) {
      console.warn(
        '[Translation] Invalid cache format. Creating a new cache.'
      );

      cache =
        createEmptyCache();

      return cache;
    }

    cache = {
      version: 2,
      sourceLanguage: 'en',
      translations:
        parsed.translations,
    };
  } catch (error) {
    console.error(
      '[Translation] Could not load cache:',
      error
    );

    cache =
      createEmptyCache();
  }

  return cache;
}

function saveCache(): void {
  const currentCache =
    loadCache();

  try {
    fs.mkdirSync(
      path.dirname(
        CACHE_FILE
      ),
      {
        recursive: true,
      }
    );

    /*
     * Write to a temporary file first.
     * This avoids leaving a partially
     * written JSON file if the process
     * is interrupted during write.
     */
    const tempFile =
      `${CACHE_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(
        currentCache,
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(
      tempFile,
      CACHE_FILE
    );
  } catch (error) {
    /*
     * Cache failure must never
     * crash the application.
     */
    console.error(
      '[Translation] Could not save cache:',
      error
    );
  }
}

/*
 * ============================================================
 * TEXT NORMALIZATION
 * ============================================================
 */

function normalizeSourceText(
  text: string
): string {
  return text
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

/*
 * ============================================================
 * CACHE ACCESS
 * ============================================================
 */

function getCachedTranslation(
  text: string,
  language: NonEnglishLanguage
): string | undefined {
  const currentCache =
    loadCache();

  return currentCache
    .translations[language]
    ?.[text];
}

function setCachedTranslation(
  text: string,
  language: NonEnglishLanguage,
  translatedText: string
): void {
  const currentCache =
    loadCache();

  if (
    !currentCache
      .translations[
        language
      ]
  ) {
    currentCache
      .translations[
        language
      ] = {};
  }

  currentCache
    .translations[
      language
    ]![text] =
    translatedText;

  saveCache();
}

/*
 * ============================================================
 * SUPPORTED LANGUAGE CHECK
 * ============================================================
 */

export function isSupportedTranslationLanguage(
  value: string
): value is SupportedTranslationLanguage {
  return [
    'en',
    'hi',
    'bn',
    'te',
    'mr',
    'ta',
    'gu',
    'kn',
    'ml',
    'pa',
    'or',
    'as',
    'ne',
    'ur',
  ].includes(value);
}

/*
 * ============================================================
 * MYMEMORY REQUEST
 * ============================================================
 */

async function requestFromMyMemory(
  text: string,
  language: NonEnglishLanguage
): Promise<string> {
  /*
   * Do not hit MyMemory while
   * global cooldown is active.
   */
  if (
    providerBlockedUntil >
    Date.now()
  ) {
    throw new Error(
      'MyMemory provider is temporarily cooling down.'
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      REQUEST_TIMEOUT_MS
    );

  try {
    const url =
      new URL(
        'https://api.mymemory.translated.net/get'
      );

    url.searchParams.set(
      'q',
      text
    );

    url.searchParams.set(
      'langpair',
      `en|${language}`
    );

    /*
     * Optional email support.
     *
     * No email is required.
     *
     * If MYMEMORY_EMAIL exists in
     * Render environment variables,
     * it will be sent.
     */
    if (
      process.env.MYMEMORY_EMAIL
    ) {
      url.searchParams.set(
        'de',
        process.env.MYMEMORY_EMAIL
      );
    }

    const response =
      await fetch(
        url,
        {
          method: 'GET',

          signal:
            controller.signal,

          headers: {
            Accept:
              'application/json',
          },
        }
      );

    /*
     * Explicit 429 handling.
     */
    if (
      response.status ===
      429
    ) {
      providerBlockedUntil =
        Date.now() +
        PROVIDER_COOLDOWN_MS;

      throw new Error(
        'MyMemory returned HTTP 429'
      );
    }

    if (
      !response.ok
    ) {
      throw new Error(
        `MyMemory returned HTTP ${response.status}`
      );
    }

    const payload =
      (await response.json()) as {
        responseData?: {
          translatedText?: string;
        };

        responseStatus?: number;

        quotaFinished?: boolean;
      };

    /*
     * MyMemory can report an error
     * through responseStatus.
     */
    if (
      payload.responseStatus ===
      429
    ) {
      providerBlockedUntil =
        Date.now() +
        PROVIDER_COOLDOWN_MS;

      throw new Error(
        'MyMemory returned HTTP 429'
      );
    }

    if (
      payload.quotaFinished ===
      true
    ) {
      providerBlockedUntil =
        Date.now() +
        PROVIDER_COOLDOWN_MS;

      throw new Error(
        'MyMemory quota is temporarily unavailable.'
      );
    }

    const translatedText =
      payload
        .responseData
        ?.translatedText
        ?.trim();

    if (
      !translatedText
    ) {
      throw new Error(
        'MyMemory returned an empty translation.'
      );
    }

    return translatedText;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

/*
 * ============================================================
 * REQUEST QUEUE
 * ============================================================
 */

function processQueue(): void {
  while (
    activeRequests <
      MAX_CONCURRENT_REQUESTS &&
    requestQueue.length >
      0
  ) {
    /*
     * Global provider cooldown.
     *
     * Don't start another external
     * request during cooldown.
     */
    if (
      providerBlockedUntil >
      Date.now()
    ) {
      return;
    }

    const item =
      requestQueue.shift();

    if (!item) {
      return;
    }

    activeRequests += 1;

    requestFromMyMemory(
      item.text,
      item.language
    )
      .then(
        (
          translatedText
        ) => {
          failedUntil.delete(
            item.key
          );

          /*
           * IMPORTANT:
           * Save only successful
           * translations.
           */
          setCachedTranslation(
            item.text,
            item.language,
            translatedText
          );

          item.resolve(
            translatedText
          );
        }
      )
      .catch(
        (error) => {
          console.error(
            `[Translation] MyMemory request failed for ${item.language}:`,
            error
          );

          /*
           * Per-string cooldown.
           */
          failedUntil.set(
            item.key,
            Date.now() +
              FAILURE_COOLDOWN_MS
          );

          item.reject(
            error
          );
        }
      )
      .finally(
        () => {
          activeRequests -=
            1;

          pendingRequests.delete(
            item.key
          );

          /*
           * Process another request
           * only if provider is not
           * globally blocked.
           */
          processQueue();
        }
      );
  }
}

/*
 * ============================================================
 * SINGLE TRANSLATION
 * ============================================================
 */

export async function translateText(
  text: string,
  language: SupportedTranslationLanguage
): Promise<{
  text: string;
  cached: boolean;
}> {
  const normalizedText =
    normalizeSourceText(
      text
    );

  /*
   * English does not need
   * MyMemory.
   */
  if (
    language === 'en' ||
    !normalizedText
  ) {
    return {
      text,
      cached: true,
    };
  }

  /*
   * Don't send huge strings
   * to MyMemory.
   */
  if (
    normalizedText.length >
    MAX_TEXT_LENGTH
  ) {
    return {
      text,
      cached: false,
    };
  }

  const targetLanguage =
    language as NonEnglishLanguage;

  /*
   * ==========================================================
   * 1. CACHE FIRST
   * ==========================================================
   */

  const cached =
    getCachedTranslation(
      normalizedText,
      targetLanguage
    );

  if (
    cached !== undefined
  ) {
    return {
      text: cached,
      cached: true,
    };
  }

  /*
   * ==========================================================
   * 2. GLOBAL PROVIDER COOLDOWN
   * ==========================================================
   */

  if (
    providerBlockedUntil >
    Date.now()
  ) {
    return {
      text,
      cached: false,
    };
  }

  const key =
    `${targetLanguage}\u0000${normalizedText}`;

  /*
   * ==========================================================
   * 3. SAME REQUEST ALREADY RUNNING?
   * ==========================================================
   */

  const existing =
    pendingRequests.get(
      key
    );

  if (existing) {
    try {
      const translated =
        await existing;

      return {
        text: translated,
        cached: false,
      };
    } catch {
      return {
        text,
        cached: false,
      };
    }
  }

  /*
   * ==========================================================
   * 4. PREVIOUS FAILURE COOLDOWN
   * ==========================================================
   */

  const failedAt =
    failedUntil.get(
      key
    ) ?? 0;

  if (
    failedAt >
    Date.now()
  ) {
    return {
      text,
      cached: false,
    };
  }

  /*
   * ==========================================================
   * 5. CREATE ONE SHARED REQUEST
   * ==========================================================
   */

  let resolveRequest:
    (value: string) => void =
    () => undefined;

  let rejectRequest:
    (reason?: unknown) => void =
    () => undefined;

  const request =
    new Promise<string>(
      (
        resolve,
        reject
      ) => {
        resolveRequest =
          resolve;

        rejectRequest =
          reject;
      }
    );

  pendingRequests.set(
    key,
    request
  );

  /*
   * ==========================================================
   * 6. PUT INTO QUEUE
   * ==========================================================
   */

  requestQueue.push({
    key,
    text: normalizedText,
    language: targetLanguage,
    resolve:
      resolveRequest,
    reject:
      rejectRequest,
  });

  processQueue();

  /*
   * ==========================================================
   * 7. WAIT FOR RESULT
   * ==========================================================
   */

  try {
    const translated =
      await request;

    return {
      text: translated,
      cached: false,
    };
  } catch {
    /*
     * Translation failure must
     * never break the application.
     */
    return {
      text,
      cached: false,
    };
  }
}

/*
 * ============================================================
 * BATCH TRANSLATION
 * ============================================================
 *
 * IMPORTANT:
 *
 * The frontend currently sends:
 *
 * {
 *   language: "ne",
 *   texts: [
 *     "Dashboard",
 *     "Create Account",
 *     ...
 *   ]
 * }
 *
 * This function translates each unique
 * English string through translateText().
 *
 * translateText() already handles:
 *
 * - cache
 * - request deduplication
 * - queue
 * - MyMemory
 * - 429 cooldown
 * - timeout
 * - failure fallback
 *
 * Therefore we do NOT create a second
 * independent MyMemory implementation here.
 * ============================================================
 */

export async function translateBatch(
  texts: string[],
  language: SupportedTranslationLanguage
): Promise<{
  language: SupportedTranslationLanguage;
  translations: Record<
    string,
    string
  >;
  retryAfter?: number;
}> {
  /*
   * Remove duplicate strings.
   */
  const uniqueTexts =
    Array.from(
      new Set(
        texts
          .filter(
            (
              value
            ) =>
              typeof value ===
              'string'
          )
          .map(
            (
              value
            ) =>
              normalizeSourceText(
                value
              )
          )
          .filter(
            Boolean
          )
      )
    );

  const translations:
    Record<string, string> =
    {};

  /*
   * English mode:
   *
   * no MyMemory call.
   */
  if (
    language === 'en'
  ) {
    for (
      const text of uniqueTexts
    ) {
      translations[text] =
        text;
    }

    return {
      language,
      translations,
    };
  }

  /*
   * If provider is cooling down,
   * return no translations.
   *
   * The frontend will keep English
   * and apply its own retry cooldown.
   */
  if (
    providerBlockedUntil >
    Date.now()
  ) {
    return {
      language,
      translations: {},
      retryAfter: Math.ceil(
        (
          providerBlockedUntil -
          Date.now()
        ) / 1000
      ),
    };
  }

  /*
   * Translate all unique strings.

   *
   * Promise.all is safe here because
   * translateText() itself uses the
   * server-side queue and concurrency
   * limit.
   */
  await Promise.all(
    uniqueTexts.map(
      async (
        text
      ) => {
        /*
         * Check cache before creating
         * any new external work.
         */
        const cached =
          getCachedTranslation(
            text,
            language as NonEnglishLanguage
          );

        if (
          cached !== undefined
        ) {
          translations[text] =
            cached;

          return;
        }

        const result =
          await translateText(
            text,
            language
          );

        /*
         * IMPORTANT:
         *
         * Only add a translation when
         * it is actually different from
         * the original English text.
         *
         * This prevents a failed request
         * from being incorrectly cached
         * as a successful translation.
         */
        if (
          result.text !==
          text
        ) {
          translations[text] =
            result.text;
        }
      }
    )
  );

  /*
   * If MyMemory became blocked during
   * this batch, tell the frontend.
   */
  if (
    providerBlockedUntil >
    Date.now()
  ) {
    return {
      language,
      translations,
      retryAfter: Math.ceil(
        (
          providerBlockedUntil -
          Date.now()
        ) / 1000
      ),
    };
  }

  return {
    language,
    translations,
  };
}