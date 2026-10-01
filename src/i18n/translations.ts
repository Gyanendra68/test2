import fs from 'fs';
import path from 'path';
import { getDataDir } from './runtime.js';

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

type TargetLanguage = Exclude<SupportedTranslationLanguage, 'en'>;

type TranslationCache = {
  version: 2;
  sourceLanguage: 'en';
  translations: Partial<Record<TargetLanguage, Record<string, string>>>;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// MyMemory's free tier is small (anonymous: ~5,000 characters/day per IP,
// ~50,000/day when a valid email is sent in the "de" parameter) and it is
// shared by everything behind the same outbound IP (Render instances share
// IPs). So the goal of this module is to send as FEW requests as possible,
// slowly, and to stop completely as soon as MyMemory says "enough".
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_REQUESTS = 2;
const MIN_REQUEST_GAP_MS = 300; // minimum spacing between two outgoing request starts
const MAX_QUEUE_LENGTH = 400; // beyond this, extra misses fall back to English
const MAX_TEXT_BYTES = 500; // MyMemory rejects queries longer than 500 bytes
const MAX_BATCH_SIZE = 30;
const KEY_FAILURE_COOLDOWN_MS = 60_000; // per-text cooldown after a non-429 failure
const BLOCK_BASE_MS = 60_000; // first global pause after a 429
const BLOCK_MAX_MS = 30 * 60_000; // exponential back-off ceiling for plain 429s
const QUOTA_BLOCK_MAX_MS = 24 * 60 * 60_000; // ceiling when MyMemory says how long the quota lasts
const PERSIST_DEBOUNCE_MS = 500;

const SUPPORTED_LANGUAGES: readonly string[] = [
  'en', 'hi', 'bn', 'te', 'mr', 'ta', 'gu', 'kn', 'ml', 'pa', 'or', 'as', 'ne', 'ur'
];

// Where the cache file lives. Defaults to ./data (same place as before).
// On Render, set TRANSLATION_CACHE_DIR to a persistent disk mount path
// (e.g. /var/data) if you attach a disk; otherwise the in-memory cache and
// the committed seed file are used.
const CACHE_DIR = process.env.TRANSLATION_CACHE_DIR
  ? path.resolve(process.env.TRANSLATION_CACHE_DIR)
  : getDataDir();
const CACHE_FILE = path.join(CACHE_DIR, 'translations-cache-v2.json');

// Text MyMemory returns instead of a translation when something is wrong.
// These must never be shown to users or stored in the cache.
const MYMEMORY_ERROR_TEXT =
  /MYMEMORY WARNING|QUERY LENGTH LIMIT EXCEEDED|INVALID LANGUAGE PAIR|PLEASE SELECT TWO DISTINCT|INVALID EMAIL PROVIDED/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type Job = {
  key: string;
  text: string;
  language: TargetLanguage;
  resolve: (value: string | null) => void;
};

const pendingRequests = new Map<string, Promise<string | null>>();
const failedUntil = new Map<string, number>();
const queue: Job[] = [];

let cache: TranslationCache | null = null;
let activeRequests = 0;
let lastRequestStart = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let blockedUntil = 0;
let consecutiveBlocks = 0;
const lastLogAt = new Map<string, number>();

class MyMemoryBlockedError extends Error {
  retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function logLimited(id: string, message: string): void {
  const now = Date.now();
  if ((lastLogAt.get(id) || 0) + 10_000 > now) return;
  lastLogAt.set(id, now);
  console.warn(message);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
export function isSupportedTranslationLanguage(value: string): value is SupportedTranslationLanguage {
  return SUPPORTED_LANGUAGES.includes(value);
}

// Must stay identical to the normalisation done in the browser so that the
// same English text always produces the same cache key.
export function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isWithinSizeLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Cache (in memory, mirrored to a JSON file)
// ---------------------------------------------------------------------------
function createEmptyCache(): TranslationCache {
  return { version: 2, sourceLanguage: 'en', translations: {} };
}

function ensureCacheLoaded(): TranslationCache {
  if (cache) return cache;

  try {
    if (!fs.existsSync(CACHE_FILE)) {
      cache = createEmptyCache();
      return cache;
    }

    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Partial<TranslationCache>;
    if (
      parsed.version !== 2 ||
      parsed.sourceLanguage !== 'en' ||
      !parsed.translations ||
      typeof parsed.translations !== 'object'
    ) {
      cache = createEmptyCache();
      return cache;
    }

    const clean = createEmptyCache();
    let dropped = 0;
    for (const [language, entries] of Object.entries(parsed.translations)) {
      if (!isSupportedTranslationLanguage(language) || language === 'en') continue;
      if (!entries || typeof entries !== 'object') continue;
      const target: Record<string, string> = {};
      for (const [source, translated] of Object.entries(entries)) {
        if (typeof translated !== 'string' || !translated.trim() || MYMEMORY_ERROR_TEXT.test(translated)) {
          dropped += 1;
          continue;
        }
        target[source] = translated;
      }
      clean.translations[language as TargetLanguage] = target;
    }
    if (dropped > 0) {
      console.warn(`[Translation] Ignored ${dropped} unusable cache entries while loading the cache.`);
    }
    cache = clean;
  } catch (error) {
    console.error('[Translation] Failed to read cache; starting empty:', error);
    cache = createEmptyCache();
  }

  return cache;
}

function persistCacheNow(): void {
  persistTimer = null;
  const current = ensureCacheLoaded();

  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const temporaryFile = `${CACHE_FILE}.tmp`;
    // The WHOLE in-memory cache is written every time, so translations for
    // different languages that finish close together can never overwrite each other.
    fs.writeFileSync(temporaryFile, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(temporaryFile, CACHE_FILE);
  } catch (error) {
    // Read-only / ephemeral filesystems are fine: the in-memory cache keeps working.
    logLimited('persist', `[Translation] Could not write cache file (continuing with in-memory cache): ${String(error)}`);
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(persistCacheNow, PERSIST_DEBOUNCE_MS);
}

function getCachedTranslation(text: string, language: TargetLanguage): string | undefined {
  return ensureCacheLoaded().translations[language]?.[text];
}

function setCachedTranslation(text: string, language: TargetLanguage, translated: string): void {
  const current = ensureCacheLoaded();
  const bucket = (current.translations[language] ??= {});
  bucket[text] = translated;
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Global cool-down (429 / quota protection)
// ---------------------------------------------------------------------------
function isBlocked(): boolean {
  return blockedUntil > Date.now();
}

function getRetryAfterSeconds(): number | undefined {
  const remaining = blockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : undefined;
}

function applyBlock(error: MyMemoryBlockedError): void {
  // Several in-flight requests can hit 429 together; count that as ONE block.
  if (!isBlocked()) consecutiveBlocks += 1;
  const backoff = Math.min(BLOCK_BASE_MS * 2 ** (consecutiveBlocks - 1), BLOCK_MAX_MS);
  const duration = Math.min(Math.max(error.retryAfterMs ?? backoff, BLOCK_BASE_MS), QUOTA_BLOCK_MAX_MS);
  blockedUntil = Math.max(blockedUntil, Date.now() + duration);
  logLimited(
    'blocked',
    `[Translation] MyMemory limit reached (${error.message}). Pausing ALL outgoing requests for ${Math.round(duration / 1000)}s; English text is used meanwhile.`
  );

  // Everything still waiting would be rejected too - fail fast instead of sending it.
  while (queue.length > 0) {
    const job = queue.shift();
    if (job) settle(job, null);
  }
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date) && date > Date.now()) return date - Date.now();
  return undefined;
}

// MyMemory's quota message looks like:
// "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 05 HOURS 38 MINUTES 46 SECONDS ..."
function parseQuotaWaitMs(message: string): number {
  const match = /(\d+)\s*HOURS?\D+(\d+)\s*MINUTES?/i.exec(message);
  if (match) {
    return (Number(match[1]) * 60 + Number(match[2]) + 1) * 60_000;
  }
  return 60 * 60_000;
}

// ---------------------------------------------------------------------------
// MyMemory request
// ---------------------------------------------------------------------------
async function requestFromMyMemory(text: string, language: TargetLanguage): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', `en|${language}`); // English is ALWAYS the source
    const email = process.env.MYMEMORY_EMAIL?.trim();
    if (email) url.searchParams.set('de', email); // optional: raises the free daily quota

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`);
      throw new Error(`network error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.status === 429) {
      throw new MyMemoryBlockedError('HTTP 429', parseRetryAfterHeader(response.headers.get('retry-after')));
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let payload: { responseData?: { translatedText?: unknown }; responseStatus?: unknown };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new Error('invalid JSON');
    }

    const translated = payload.responseData?.translatedText;
    const status = Number(payload.responseStatus);

    if (typeof translated === 'string' && /MYMEMORY WARNING/.test(translated)) {
      throw new MyMemoryBlockedError('daily quota used up', parseQuotaWaitMs(translated));
    }
    if (status === 429) {
      throw new MyMemoryBlockedError('responseStatus 429');
    }
    if (!Number.isNaN(status) && status !== 200) {
      throw new Error(`responseStatus ${status}`);
    }
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new Error('missing translatedText');
    }
    if (MYMEMORY_ERROR_TEXT.test(translated)) {
      throw new Error('MyMemory returned an error message instead of a translation');
    }

    const result = decodeHtmlEntities(translated).trim();
    if (!result) throw new Error('empty translation');
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Queue (small concurrency + pacing)
// ---------------------------------------------------------------------------
function settle(job: Job, value: string | null): void {
  pendingRequests.delete(job.key);
  job.resolve(value);
}

async function runJob(job: Job): Promise<void> {
  try {
    const translated = await requestFromMyMemory(job.text, job.language);
    consecutiveBlocks = 0;
    failedUntil.delete(job.key);
    setCachedTranslation(job.text, job.language, translated);
    settle(job, translated);
  } catch (error) {
    if (error instanceof MyMemoryBlockedError) {
      applyBlock(error);
    } else {
      failedUntil.set(job.key, Date.now() + KEY_FAILURE_COOLDOWN_MS);
      const reason = error instanceof Error ? error.message : String(error);
      logLimited(`fail:${job.language}:${reason}`, `[Translation] MyMemory request failed for ${job.language}: ${reason}`);
    }
    settle(job, null);
  }
}

function pump(): void {
  while (queue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    if (pumpTimer) return; // a delayed start is already scheduled

    if (isBlocked()) {
      const job = queue.shift();
      if (job) settle(job, null);
      continue;
    }

    const wait = lastRequestStart + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) {
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        pump();
      }, wait);
      return;
    }

    const job = queue.shift();
    if (!job) return;

    activeRequests += 1;
    lastRequestStart = Date.now();
    void runJob(job).finally(() => {
      activeRequests -= 1;
      pump();
    });
  }
}

function pruneFailures(): void {
  if (failedUntil.size < 2000) return;
  const now = Date.now();
  for (const [key, until] of failedUntil) {
    if (until <= now) failedUntil.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Core lookup: cache -> pending request -> queue -> MyMemory
// ---------------------------------------------------------------------------
async function translateOne(
  normalizedText: string,
  language: TargetLanguage
): Promise<{ translation: string | null; cached: boolean }> {
  const cachedTranslation = getCachedTranslation(normalizedText, language);
  if (cachedTranslation !== undefined) {
    return { translation: cachedTranslation, cached: true };
  }

  const key = `${language}\u0000${normalizedText}`;

  // Same text + same language already in flight: share that single request.
  const existing = pendingRequests.get(key);
  if (existing) {
    return { translation: await existing, cached: false };
  }

  if (isBlocked()) return { translation: null, cached: false };
  if ((failedUntil.get(key) || 0) > Date.now()) return { translation: null, cached: false };
  if (queue.length >= MAX_QUEUE_LENGTH) return { translation: null, cached: false };

  pruneFailures();

  const request = new Promise<string | null>((resolve) => {
    queue.push({ key, text: normalizedText, language, resolve });
  });
  pendingRequests.set(key, request);
  pump();

  return { translation: await request, cached: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface TranslateResult {
  text: string;
  cached: boolean;
  translated: boolean;
  retryAfter?: number;
}

// Single text. Response shape is backwards compatible: { text, cached } (+ extras).
export async function translateText(
  text: string,
  language: SupportedTranslationLanguage
): Promise<TranslateResult> {
  const normalizedText = normalizeSourceText(text);

  if (!normalizedText || language === 'en') {
    return { text, cached: true, translated: false };
  }
  if (!isWithinSizeLimit(normalizedText)) {
    return { text, cached: false, translated: false };
  }

  const { translation, cached } = await translateOne(normalizedText, language as TargetLanguage);
  if (translation === null) {
    return { text, cached: false, translated: false, retryAfter: getRetryAfterSeconds() };
  }
  return { text: translation, cached, translated: true };
}

export interface BatchTranslateResult {
  language: SupportedTranslationLanguage;
  // Only successful translations are included, keyed by the normalised English text.
  translations: Record<string, string>;
  retryAfter?: number;
}

export { MAX_BATCH_SIZE };

export async function translateBatch(
  texts: string[],
  language: SupportedTranslationLanguage
): Promise<BatchTranslateResult> {
  if (language === 'en') return { language, translations: {} };

  const unique = new Set<string>();
  for (const text of texts) {
    const normalized = normalizeSourceText(text);
    if (normalized && isWithinSizeLimit(normalized)) unique.add(normalized);
  }

  const translations: Record<string, string> = {};
  const entries = Array.from(unique);
  const results = await Promise.all(entries.map((entry) => translateOne(entry, language as TargetLanguage)));
  results.forEach((result, index) => {
    if (result.translation !== null) translations[entries[index]] = result.translation;
  });

  return { language, translations, retryAfter: getRetryAfterSeconds() };
}