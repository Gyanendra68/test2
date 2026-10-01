import fs from 'fs';
import path from 'path';

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

const CACHE_FILE = path.resolve(
  'data',
  'translations-cache-v2.json'
);

const REQUEST_TIMEOUT_MS = 8000;

/*
 * After a failed request, don't immediately send the
 * same request again. This is especially important for
 * MyMemory HTTP 429 responses.
 */
const FAILURE_COOLDOWN_MS = 30000;

/*
 * Keep the number of simultaneous MyMemory requests small.
 */
const MAX_CONCURRENT_REQUESTS = 2;

/*
 * Prevent excessively large requests.
 */
const MAX_TEXT_LENGTH = 1000;

/*
 * Pending requests are shared.

 * If multiple UI elements request the same:
 *
 * "Apply Now" + "ne"
 *
 * while the first request is running, all of them
 * reuse the same Promise instead of making multiple
 * MyMemory requests.
 */
const pendingRequests = new Map<
  string,
  Promise<string>
>();

/*
 * Failed requests are temporarily cooled down.
 */
const failedUntil = new Map<
  string,
  number
>();

type QueueItem = {
  key: string;
  text: string;
  language: NonEnglishLanguage;
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

const queue: QueueItem[] = [];

let activeRequests = 0;
let cache: TranslationCache | null = null;

function createEmptyCache(): TranslationCache {
  return {
    version: 2,
    sourceLanguage: 'en',
    translations: {},
  };
}

function ensureCacheLoaded(): TranslationCache {
  if (cache) {
    return cache;
  }

  try {
    if (!fs.existsSync(CACHE_FILE)) {
      cache = createEmptyCache();
      return cache;
    }

    const raw = fs.readFileSync(
      CACHE_FILE,
      'utf8'
    );

    const parsed = JSON.parse(
      raw
    ) as Partial<TranslationCache>;

    if (
      parsed.version !== 2 ||
      parsed.sourceLanguage !== 'en' ||
      !parsed.translations ||
      typeof parsed.translations !== 'object'
    ) {
      console.warn(
        '[Translation] Invalid cache format. Starting with empty cache.'
      );

      cache = createEmptyCache();
      return cache;
    }

    cache = {
      version: 2,
      sourceLanguage: 'en',
      translations: parsed.translations,
    };
  } catch (error) {
    console.error(
      '[Translation] Failed to read translation cache:',
      error
    );

    cache = createEmptyCache();
  }

  return cache;
}

function persistCache(): void {
  const currentCache = ensureCacheLoaded();

  try {
    fs.mkdirSync(
      path.dirname(CACHE_FILE),
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
    /*
     * Cache failure must never crash the application.
     */
    console.error(
      '[Translation] Failed to persist translation cache:',
      error
    );
  }
}

function normalizeText(text: string): string {
  return text.trim();
}

function cacheKey(
  text: string,
  language: NonEnglishLanguage
): string {
  return `en:${language}:${text}`;
}

function getCachedTranslation(
  text: string,
  language: NonEnglishLanguage
): string | undefined {
  const currentCache =
    ensureCacheLoaded();

  return currentCache.translations[
    language
  ]?.[text];
}

function setCachedTranslation(
  text: string,
  language: NonEnglishLanguage,
  translatedText: string
): void {
  const currentCache =
    ensureCacheLoaded();

  if (!currentCache.translations[language]) {
    currentCache.translations[language] = {};
  }

  currentCache.translations[
    language
  ]![text] = translatedText;

  persistCache();
}

async function requestFromMyMemory(
  text: string,
  language: NonEnglishLanguage
): Promise<string> {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const url = new URL(
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

    const response = await fetch(
      url,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `MyMemory returned HTTP ${response.status}`
      );
    }

    const payload =
      await response.json() as {
        responseData?: {
          translatedText?: string;
        };
        responseStatus?: number;
      };

    /*
     * MyMemory may communicate failure through
     * responseStatus even when the HTTP status is 200.
     */
    if (
      payload.responseStatus === 429
    ) {
      throw new Error(
        'MyMemory returned HTTP 429'
      );
    }

    const translatedText =
      payload.responseData
        ?.translatedText
        ?.trim();

    if (!translatedText) {
      throw new Error(
        'MyMemory returned no usable translation'
      );
    }

    return translatedText;
  } finally {
    clearTimeout(timeout);
  }
}

function processQueue(): void {
  while (
    activeRequests <
      MAX_CONCURRENT_REQUESTS &&
    queue.length > 0
  ) {
    const item =
      queue.shift();

    if (!item) {
      return;
    }

    activeRequests += 1;

    requestFromMyMemory(
      item.text,
      item.language
    )
      .then(
        (translatedText) => {
          failedUntil.delete(
            item.key
          );

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
          /*
           * Put the exact request into cooldown.
           * This prevents repeated 429 requests.
           */
          failedUntil.set(
            item.key,
            Date.now() +
              FAILURE_COOLDOWN_MS
          );

          item.reject(error);
        }
      )
      .finally(() => {
        activeRequests -= 1;

        pendingRequests.delete(
          item.key
        );

        processQueue();
      });
  }
}

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

export async function translateText(
  text: string,
  language: SupportedTranslationLanguage
): Promise<{
  text: string;
  cached: boolean;
}> {
  const normalizedText =
    normalizeText(text);

  /*
   * English never calls MyMemory.
   */
  if (
    !normalizedText ||
    language === 'en'
  ) {
    return {
      text,
      cached: true,
    };
  }

  /*
   * Never send excessively large strings.
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
   * 1. CACHE FIRST
   */
  const cachedTranslation =
    getCachedTranslation(
      normalizedText,
      targetLanguage
    );

  if (
    cachedTranslation !== undefined
  ) {
    return {
      text: cachedTranslation,
      cached: true,
    };
  }

  const key = cacheKey(
    normalizedText,
    targetLanguage
  );

  /*
   * 2. REQUEST DEDUPLICATION
   *
   * If the same text/language request
   * is already running, reuse it.
   */
  const existingRequest =
    pendingRequests.get(key);

  if (existingRequest) {
    try {
      const translated =
        await existingRequest;

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
   * 3. FAILURE COOLDOWN
   *
   * Prevent immediate repeated calls
   * after MyMemory failure / HTTP 429.
   */
  const retryAfter =
    failedUntil.get(key) ?? 0;

  if (retryAfter > Date.now()) {
    return {
      text,
      cached: false,
    };
  }

  /*
   * 4. QUEUE THE REQUEST
   */
  const request =
    new Promise<string>(
      (resolve, reject) => {
        queue.push({
          key,
          text: normalizedText,
          language: targetLanguage,
          resolve,
          reject,
        });

        processQueue();
      }
    );

  pendingRequests.set(
    key,
    request
  );

  try {
    const translated =
      await request;

    return {
      text: translated,
      cached: false,
    };
  } catch (error) {
    console.error(
      `[Translation] MyMemory request failed for ${targetLanguage}:`,
      error
    );

    /*
     * Translation failure must NEVER
     * break the application.
     *
     * Return original English.
     */
    return {
      text,
      cached: false,
    };
  }
}