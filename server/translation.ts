import fs from 'fs';
import path from 'path';

/**
 * ============================================================
 * SUPPORTED TRANSLATION LANGUAGES
 * ============================================================
 *
 * English is the source language.
 * All other languages are translated through MyMemory.
 *
 * No translation text is hard-coded in this file.
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

type NonEnglishLanguage = Exclude<
  SupportedTranslationLanguage,
  'en'
>;

/**
 * ============================================================
 * BATCH CONFIGURATION
 * ============================================================
 *
 * The current frontend sends batches of 6 strings.
 *
 * Keep this compatible with the existing frontend.
 */
export const MAX_BATCH_SIZE = 6;

/**
 * ============================================================
 * CACHE CONFIGURATION
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

/**
 * ============================================================
 * REQUEST CONFIGURATION
 * ============================================================
 */

/**
 * Maximum time allowed for one MyMemory request.
 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * After a failed request for a specific
 * text/language pair, don't immediately
 * request it again.
 */
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * After MyMemory returns HTTP 429,
 * temporarily stop ALL MyMemory calls.
 */
const PROVIDER_COOLDOWN_MS = 30_000;

/**
 * Only one external MyMemory request at a time.
 *
 * This is intentional.
 *
 * The frontend already batches strings.
 * Sending many simultaneous requests to
 * MyMemory can trigger 429 rate limiting.
 */
const MAX_CONCURRENT_REQUESTS = 1;

/**
 * Don't send extremely large DOM strings
 * to MyMemory.
 */
const MAX_TEXT_LENGTH = 1000;

/**
 * ============================================================
 * CACHE STATE
 * ============================================================
 */

let cache: TranslationCache | null = null;

/**
 * Same text + same language currently
 * being translated.
 *
 * Example:
 *
 * "Dashboard" + "mr"
 *
 * If requested multiple times at once,
 * only ONE MyMemory request is made.
 */
const pendingRequests =
  new Map<
    string,
    Promise<string>
  >();

/**
 * Per text/language failure cooldown.
 */
const failedUntil =
  new Map<
    string,
    number
  >();

/**
 * Global MyMemory cooldown.
 */
let providerBlockedUntil = 0;

/**
 * ============================================================
 * QUEUE
 * ============================================================
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

const requestQueue: QueueItem[] = [];

let activeRequests = 0;

let queueRunning = false;

/**
 * ============================================================
 * CACHE CREATION
 * ============================================================
 */

function createEmptyCache(): TranslationCache {
  return {
    version: 2,
    sourceLanguage: 'en',
    translations: {},
  };
}

/**
 * ============================================================
 * LOAD CACHE
 * ============================================================
 */

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
      parsed.sourceLanguage !== 'en' ||
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
      '[Translation] Failed to load translation cache:',
      error
    );

    cache =
      createEmptyCache();
  }

  return cache;
}

/**
 * ============================================================
 * SAVE CACHE
 * ============================================================
 */

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

    const temporaryFile =
      `${CACHE_FILE}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(
        currentCache,
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(
      temporaryFile,
      CACHE_FILE
    );
  } catch (error) {
    /**
     * Cache failure must NEVER
     * crash the application.
     */
    console.error(
      '[Translation] Failed to save translation cache:',
      error
    );
  }
}

/**
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

/**
 * ============================================================
 * CACHE READ
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

/**
 * ============================================================
 * CACHE WRITE
 * ============================================================
 *
 * Only successful translations
 * should reach this function.
 */
function setCachedTranslation(
  text: string,
  language: NonEnglishLanguage,
  translatedText: string
): void {
  const cleaned =
    translatedText.trim();

  if (!cleaned) {
    return;
  }

  /**
   * Never cache a failed fallback
   * as a successful translation.
   */
  if (
    cleaned === text
  ) {
    return;
  }

  const currentCache =
    loadCache();

  if (
    !currentCache.translations[
      language
    ]
  ) {
    currentCache.translations[
      language
    ] = {};
  }

  currentCache.translations[
    language
  ]![text] = cleaned;

  saveCache();
}

/**
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

/**
 * ============================================================
 * HTML ENTITY DECODER
 * ============================================================
 *
 * MyMemory can sometimes return escaped
 * HTML entities.
 *
 * No external package is required.
 */
function decodeHtmlEntities(
  value: string
): string {
  return value
    .replace(
      /&amp;/g,
      '&'
    )
    .replace(
      /&lt;/g,
      '<'
    )
    .replace(
      /&gt;/g,
      '>'
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&#x27;/gi,
      "'"
    );
}

/**
 * ============================================================
 * MYMEMORY API REQUEST
 * ============================================================
 */

async function requestFromMyMemory(
  text: string,
  language: NonEnglishLanguage
): Promise<string> {
  /**
   * Global provider cooldown.
   */
  if (
    providerBlockedUntil >
    Date.now()
  ) {
    throw new Error(
      'MYMEMORY_PROVIDER_COOLDOWN'
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

    /**
     * Email is OPTIONAL.
     *
     * If MYMEMORY_EMAIL exists in
     * Render environment variables,
     * use it.
     *
     * Otherwise MyMemory is called
     * without an email.
     */
    if (
      process.env.MYMEMORY_EMAIL &&
      process.env.MYMEMORY_EMAIL.trim()
    ) {
      url.searchParams.set(
        'de',
        process.env.MYMEMORY_EMAIL.trim()
      );
    }

    console.log(
      `[Translation] MyMemory request: en -> ${language}`
    );

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

    /**
     * ========================================================
     * HTTP 429
     * ========================================================
     *
     * DO NOT immediately retry.
     *
     * Mark provider as temporarily
     * unavailable.
     */
    if (
      response.status ===
      429
    ) {
      providerBlockedUntil =
        Date.now() +
        PROVIDER_COOLDOWN_MS;

      throw new Error(
        'MYMEMORY_HTTP_429'
      );
    }

    /**
     * Other HTTP errors.
     */
    if (
      !response.ok
    ) {
      throw new Error(
        `MYMEMORY_HTTP_${response.status}`
      );
    }

    const payload =
      (await response.json()) as {
        responseData?: {
          translatedText?: string;
        };

        responseStatus?: number;

        quotaFinished?: boolean;

        matches?: Array<{
          translation?: string;
        }>;
      };

    /**
     * MyMemory can sometimes report
     * a quota/rate-limit condition
     * inside the JSON response.
     */
    if (
      payload.responseStatus ===
      429
    ) {
      providerBlockedUntil =
        Date.now() +
        PROVIDER_COOLDOWN_MS;

      throw new Error(
        'MYMEMORY_JSON_429'
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
        'MYMEMORY_QUOTA_FINISHED'
      );
    }

    /**
     * Primary translated result.
     */
    let translatedText =
      payload
        .responseData
        ?.translatedText
        ?.trim();

    /**
     * Fallback to matches if needed.
     */
    if (
      !translatedText &&
      Array.isArray(
        payload.matches
      )
    ) {
      translatedText =
        payload.matches.find(
          (match) =>
            typeof match.translation ===
              'string' &&
            match.translation.trim()
        )?.translation?.trim();
    }

    if (
      !translatedText
    ) {
      throw new Error(
        'MYMEMORY_EMPTY_TRANSLATION'
      );
    }

    translatedText =
      decodeHtmlEntities(
        translatedText
      ).trim();

    /**
     * If provider returned exactly
     * the source text, don't treat it
     * as a useful translation.
     */
    if (
      !translatedText ||
      translatedText === text
    ) {
      throw new Error(
        'MYMEMORY_UNCHANGED_TRANSLATION'
      );
    }

    return translatedText;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

/**
 * ============================================================
 * FAIL ALL QUEUED REQUESTS
 * ============================================================
 *
 * This is important for 429.
 *
 * Without this, requests remaining in
 * the queue can stay unresolved.
 */
function failQueuedRequests(): void {
  const items =
    requestQueue.splice(
      0,
      requestQueue.length
    );

  for (
    const item of items
  ) {
    pendingRequests.delete(
      item.key
    );

    item.reject(
      new Error(
        'MYMEMORY_PROVIDER_COOLDOWN'
      )
    );
  }
}

/**
 * ============================================================
 * PROCESS QUEUE
 * ============================================================
 */

function processQueue(): void {
  if (queueRunning) {
    return;
  }

  queueRunning = true;

  void (async () => {
    try {
      while (
        requestQueue.length >
        0
      ) {
        /**
         * Provider is currently
         * rate limited.
         */
        if (
          providerBlockedUntil >
          Date.now()
        ) {
          failQueuedRequests();
          break;
        }

        /**
         * Safety check.
         */
        if (
          activeRequests >=
          MAX_CONCURRENT_REQUESTS
        ) {
          break;
        }

        const item =
          requestQueue.shift();

        if (!item) {
          break;
        }

        activeRequests += 1;

        try {
          const translated =
            await requestFromMyMemory(
              item.text,
              item.language
            );

          /**
           * Successful translation:
           * save it to cache.
           */
          setCachedTranslation(
            item.text,
            item.language,
            translated
          );

          failedUntil.delete(
            item.key
          );

          item.resolve(
            translated
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          console.error(
            `[Translation] MyMemory request failed for ${item.language}: ${message}`
          );

          /**
           * 429 / provider cooldown.
           *
           * Fail the current request
           * and all queued requests.
           */
          if (
            message ===
              'MYMEMORY_HTTP_429' ||
            message ===
              'MYMEMORY_JSON_429' ||
            message ===
              'MYMEMORY_QUOTA_FINISHED' ||
            message ===
              'MYMEMORY_PROVIDER_COOLDOWN'
          ) {
            failedUntil.set(
              item.key,
              Date.now() +
                FAILURE_COOLDOWN_MS
            );

            item.reject(
              error
            );

            failQueuedRequests();
          } else {
            /**
             * Normal failure.
             *
             * Cool down this specific
             * text/language pair only.
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
        } finally {
          activeRequests -= 1;

          pendingRequests.delete(
            item.key
          );
        }
      }
    } finally {
      queueRunning = false;

      /**
       * If something was added while
       * the queue was finishing,
       * process it again.
       */
      if (
        requestQueue.length >
          0 &&
        providerBlockedUntil <=
          Date.now()
      ) {
        processQueue();
      }
    }
  })();
}

/**
 * ============================================================
 * SINGLE TEXT TRANSLATION
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

  /**
   * English:
   * no external API call.
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

  /**
   * Ignore extremely large text.
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

  /**
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

  /**
   * ==========================================================
   * 2. GLOBAL 429 COOLDOWN
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

  /**
   * ==========================================================
   * 3. REQUEST KEY
   * ==========================================================
   */

  const key =
    `${targetLanguage}\u0000${normalizedText}`;

  /**
   * ==========================================================
   * 4. SAME REQUEST ALREADY RUNNING
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

  /**
   * ==========================================================
   * 5. SPECIFIC FAILURE COOLDOWN
   * ==========================================================
   */

  const failedUntilTime =
    failedUntil.get(
      key
    ) ?? 0;

  if (
    failedUntilTime >
    Date.now()
  ) {
    return {
      text,
      cached: false,
    };
  }

  /**
   * ==========================================================
   * 6. CREATE SHARED PROMISE
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

  /**
   * ==========================================================
   * 7. ADD TO QUEUE
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

  /**
   * ==========================================================
   * 8. WAIT
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
    /**
     * Translation must never
     * break the application.
     */
    return {
      text,
      cached: false,
    };
  }
}

/**
 * ============================================================
 * BATCH TRANSLATION
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
  /**
   * Remove duplicates.
   *
   * This prevents the same English
   * text from being processed multiple
   * times in one batch.
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

  /**
   * English:
   * return source strings.
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

  /**
   * ==========================================================
   * GLOBAL PROVIDER COOLDOWN
   * ==========================================================
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

  /**
   * ==========================================================
   * PROCESS UNIQUE STRINGS
   * ==========================================================
   *
   * translateText() handles:
   *
   * - cache
   * - duplicate requests
   * - queue
   * - MyMemory
   * - timeout
   * - 429 cooldown
   * - failure handling
   */

  await Promise.all(
    uniqueTexts.map(
      async (
        text
      ) => {
        /**
         * Check cache once more.
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

        /**
         * Only return a successful
         * translation.
         *
         * Failed requests return
         * the original English text
         * from translateText().
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

  /**
   * If a 429 happened during this
   * batch, tell the frontend how long
   * to wait.
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