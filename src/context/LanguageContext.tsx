import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Language, TranslationDictionary, englishTranslations, supportedLanguages } from '../i18n/translations';

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: TranslationDictionary;
  translateText: (text: string) => Promise<string>;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LANGUAGE_STORAGE_KEY = 'tribal_lang';
const BATCH_SIZE = 6; // strings per HTTP request to /api/translate/batch
const BATCH_TIMEOUT_MS = 60_000;
const BASE_FAILURE_COOLDOWN_MS = 60_000; // wait before asking again for a string that failed
const MAX_FAILURE_COOLDOWN_MS = 30 * 60_000;
const MAX_RETRY_TIMER_MS = 30 * 60_000;
const SCAN_DEBOUNCE_MS = 40;
const MAX_TEXT_BYTES = 500; // MyMemory limit; longer strings stay in English
const TRANSLATED_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
const EXCLUDED_SELECTOR = 'svg, [aria-hidden="true"], [data-no-translate]';
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'PRE', 'CODE']);
const PROTECTED_TOKENS = new Set(['J', 'JAGO', 'MoTA', 'DigiLocker', 'APAAR', 'UIDAI', 'PFMS', 'ST', 'PVTG']);
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

// Same normalisation as the server (server/translation.ts -> normalizeSourceText),
// so the browser and the server always agree on the cache key.
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fitsRequestLimit(text: string): boolean {
  return (textEncoder ? textEncoder.encode(text).length : text.length) <= MAX_TEXT_BYTES;
}

function isTranslatableText(trimmed: string): boolean {
  if (!trimmed) return false;
  // Needs at least one Latin letter: skips numbers/symbols AND text that is already
  // non-English (English is the only source language we translate from).
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (PROTECTED_TOKENS.has(trimmed) || (/^[A-Z0-9][A-Z0-9 .&/+-]{1,24}$/.test(trimmed) && !/\s/.test(trimmed))) return false;
  if (/^(https?:\/\/|mailto:|tel:|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(trimmed)) return false;
  if (/^[\d\s.,:/#%+()₹$€£-]+$/.test(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Client-side translation manager (one instance for the whole page)
//
//   in-memory cache -> pending-request map -> queue -> small sequential batches
//   -> server (/api/translate/batch) -> server cache / MyMemory
//
// It lives outside React so StrictMode's double effects, re-renders and language
// switches can never create duplicate queues, timers or requests.
// ---------------------------------------------------------------------------
type Waiter = { promise: Promise<string | null>; resolve: (value: string | null) => void };
type QueueItem = { lang: Language; key: string };

class ClientTranslator {
  private cache = new Map<Language, Map<string, string>>();
  private failures = new Map<string, { until: number; count: number }>();
  private waiting = new Map<string, Waiter>();
  private queue: QueueItem[] = [];
  private running = false;
  private blockedUntil = 0;
  private current: { lang: Language; controller: AbortController; cancelled: boolean } | null = null;
  private listeners = new Set<() => void>();

  private id(lang: Language, key: string): string {
    return `${lang}\u0000${key}`;
  }

  getCached(lang: Language, key: string): string | undefined {
    return this.cache.get(lang)?.get(key);
  }

  // Timestamp when this string may be requested again (0 = can be requested now).
  retryAt(lang: Language, key: string): number {
    const now = Date.now();
    const failure = this.failures.get(this.id(lang, key));
    const until = Math.max(failure?.until ?? 0, this.blockedUntil);
    return until > now ? until : 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Called when the selected language changes: work for any other language is dropped.
  setActiveLanguage(lang: Language): void {
    this.queue = this.queue.filter((item) => {
      if (item.lang === lang) return true;
      this.release(this.id(item.lang, item.key), null);
      return false;
    });
    if (this.current && this.current.lang !== lang) {
      this.current.cancelled = true;
      this.current.controller.abort();
    }
  }

  request(lang: Language, key: string): Promise<string | null> {
    if (lang === 'en' || !key) return Promise.resolve(null);

    const cached = this.getCached(lang, key);
    if (cached !== undefined) return Promise.resolve(cached);

    const id = this.id(lang, key);
    const existing = this.waiting.get(id);
    if (existing) return existing.promise; // same text + same language: reuse

    if (this.retryAt(lang, key) > 0) return Promise.resolve(null); // cooling down: keep English

    let resolve: (value: string | null) => void = () => undefined;
    const promise = new Promise<string | null>((res) => {
      resolve = res;
    });
    this.waiting.set(id, { promise, resolve });
    this.queue.push({ lang, key });
    void this.run();
    return promise;
  }

  private release(id: string, value: string | null): void {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    waiter.resolve(value);
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[Translation] listener failed:', error);
      }
    });
  }

  private drainQueue(): void {
    const items = this.queue;
    this.queue = [];
    items.forEach((item) => this.release(this.id(item.lang, item.key), null));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // One batch in flight at a time. Results are applied after every batch, so the
      // page translates progressively instead of waiting for everything.
      while (this.queue.length > 0) {
        if (Date.now() < this.blockedUntil) {
          this.drainQueue();
          break;
        }

        const lang = this.queue[0].lang;
        const keys: string[] = [];
        const remaining: QueueItem[] = [];
        for (const item of this.queue) {
          if (item.lang === lang && keys.length < BATCH_SIZE) keys.push(item.key);
          else remaining.push(item);
        }
        this.queue = remaining;

        await this.sendBatch(lang, keys);
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }

  private async sendBatch(lang: Language, keys: string[]): Promise<void> {
    const state = { lang, controller: new AbortController(), cancelled: false };
    this.current = state;
    const timeout = setTimeout(() => state.controller.abort(), BATCH_TIMEOUT_MS);

    let translations: Record<string, unknown> = {};
    let retryAfterMs = 0;

    try {
      const response = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang, texts: keys }),
        signal: state.controller.signal
      });

      if (response.ok) {
        const payload = (await response.json()) as { translations?: Record<string, unknown>; retryAfter?: number };
        if (payload.translations && typeof payload.translations === 'object') translations = payload.translations;
        if (typeof payload.retryAfter === 'number' && payload.retryAfter > 0) retryAfterMs = payload.retryAfter * 1000;
      } else if (response.status === 429) {
        retryAfterMs = (Number(response.headers.get('retry-after')) || 60) * 1000;
      }
    } catch {
      // Network error, timeout, abort or invalid JSON: treated as "no translation" below.
      // The page simply keeps its English text.
    } finally {
      clearTimeout(timeout);
      if (this.current === state) this.current = null;
    }

    if (retryAfterMs > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryAfterMs);
    }

    let bucket = this.cache.get(lang);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.cache.set(lang, bucket);
    }

    for (const key of keys) {
      const id = this.id(lang, key);
      const value = translations[key];

      if (typeof value === 'string' && value.trim()) {
        bucket.set(key, value);
        this.failures.delete(id);
        this.release(id, value);
        continue;
      }

      if (!state.cancelled) {
        // Exponential cool-down per string: a failed string is not requested again
        // immediately, and never in a tight loop.
        const count = (this.failures.get(id)?.count ?? 0) + 1;
        const cooldown = Math.min(BASE_FAILURE_COOLDOWN_MS * 2 ** (count - 1), MAX_FAILURE_COOLDOWN_MS);
        this.failures.set(id, { count, until: Date.now() + Math.max(cooldown, retryAfterMs) });
      }
      this.release(id, null);
    }
  }
}

const translator = new ClientTranslator();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
// For every translated DOM text node / attribute we remember the ENGLISH source and
// the exact string we last wrote ("applied"). Translation always starts from the
// English source, never from already translated text.
interface TrackedValue {
  source: string;
  applied: string | null;
}

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY) as Language | null;
      return saved && supportedLanguages.some((item) => item.code === saved) ? saved : 'en';
    } catch {
      return 'en';
    }
  });
  const textStates = useRef(new Map<Text, TrackedValue>());
  const attributeStates = useRef(new Map<Element, Map<string, TrackedValue>>());

  // Only the existing language key is written; nothing else in storage is touched.
  const setLang = useCallback((newLang: Language) => {
    setLangState(newLang);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, newLang);
    } catch {
      // Storage unavailable (private mode etc.): the language still changes for this session.
    }
  }, []);

  const t = englishTranslations;

  const translateText = useCallback(async (text: string): Promise<string> => {
    if (lang === 'en' || !text.trim()) return text;
    const key = normalizeText(text);
    const cached = translator.getCached(lang, key);
    if (cached !== undefined) return cached;
    const translated = await translator.request(lang, key);
    return translated ?? text;
  }, [lang]);

  useEffect(() => {
    // English: nothing to translate. The cleanup of the previous language's effect has
    // already restored the original English text synchronously, and
    // setActiveLanguage('en') drops any queued/in-flight work.
    translator.setActiveLanguage(lang);
    if (lang === 'en') return;

    const texts = textStates.current;
    const attributes = attributeStates.current;
    let cancelled = false;
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const restoreOriginals = () => {
      texts.forEach((tracked, node) => {
        if (tracked.applied !== null && node.isConnected && node.nodeValue === tracked.applied) {
          node.nodeValue = tracked.source;
        }
      });
      attributes.forEach((tracked, element) => {
        tracked.forEach((value, name) => {
          if (value.applied !== null && element.isConnected && element.getAttribute(name) === value.applied) {
            element.setAttribute(name, value.source);
          }
        });
      });
      texts.clear();
      attributes.clear();
    };

    // One idempotent pass over the DOM:
    //   - already-cached translations are written immediately (synchronously)
    //   - uncached English strings are handed to the translator (deduplicated)
    // Running it again when nothing changed writes nothing, so it can never loop.
    const scan = () => {
      scanTimer = null;
      if (cancelled || !document.body) return;

      const wanted = new Set<string>();
      let retryAt = 0;

      const process = (tracked: TrackedValue, current: string, write: (value: string) => void) => {
        const expected = tracked.applied !== null ? tracked.applied : tracked.source;
        if (current !== expected) {
          // React (or the app) changed this text after we last touched it:
          // the new value is the new English source.
          tracked.source = current;
          tracked.applied = null;
        }

        const core = tracked.source.trim();
        if (!isTranslatableText(core)) return;

        const key = normalizeText(core);
        const translated = translator.getCached(lang, key);

        if (translated !== undefined) {
          const leading = /^\s*/.exec(tracked.source)?.[0] ?? '';
          const trailing = /\s*$/.exec(tracked.source)?.[0] ?? '';
          const next = leading + translated + trailing;
          if (current !== next) write(next);
          tracked.applied = next;
          return;
        }

        if (!fitsRequestLimit(key)) return; // too long for MyMemory: stays English

        const waitUntil = translator.retryAt(lang, key);
        if (waitUntil > 0) {
          retryAt = retryAt === 0 ? waitUntil : Math.min(retryAt, waitUntil);
          return;
        }
        wanted.add(key);
      };

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const parent = textNode.parentElement;
        const value = textNode.nodeValue || '';
        if (!parent || !value.trim() || IGNORED_TAGS.has(parent.tagName) || parent.closest(EXCLUDED_SELECTOR)) continue;

        let tracked = texts.get(textNode);
        if (!tracked) {
          if (!isTranslatableText(value.trim())) continue;
          tracked = { source: value, applied: null };
          texts.set(textNode, tracked);
        }
        process(tracked, value, (next) => {
          textNode.nodeValue = next;
        });
      }

      document.body.querySelectorAll('[placeholder], [title], [aria-label]').forEach((element) => {
        if (element.closest(EXCLUDED_SELECTOR)) return;
        for (const name of TRANSLATED_ATTRIBUTES) {
          const value = element.getAttribute(name);
          if (!value || !value.trim()) continue;

          let byName = attributes.get(element);
          let tracked = byName?.get(name);
          if (!tracked) {
            if (!isTranslatableText(value.trim())) continue;
            if (!byName) {
              byName = new Map<string, TrackedValue>();
              attributes.set(element, byName);
            }
            tracked = { source: value, applied: null };
            byName.set(name, tracked);
          }
          process(tracked, value, (next) => {
            element.setAttribute(name, next);
          });
        }
      });

      // Forget nodes React has removed.
      texts.forEach((_tracked, textNode) => {
        if (!textNode.isConnected) texts.delete(textNode);
      });
      attributes.forEach((_tracked, element) => {
        if (!element.isConnected) attributes.delete(element);
      });

      wanted.forEach((key) => {
        void translator.request(lang, key);
      });

      // Strings that are cooling down get ONE later re-check (never a loop).
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (retryAt > 0) {
        const delay = Math.min(Math.max(retryAt - Date.now(), 1000), MAX_RETRY_TIMER_MS) + 50;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          scheduleScan(0);
        }, delay);
      }
    };

    const scheduleScan = (delay: number) => {
      if (cancelled || scanTimer !== null) return;
      scanTimer = setTimeout(scan, delay);
    };

    // The observer is NEVER disconnected while translating, so anything React renders
    // at any moment is noticed. Our own writes are recognised (the node still holds
    // exactly the string we applied) and ignored, which prevents translate -> mutate ->
    // translate loops.
    const observer = new MutationObserver((records) => {
      if (cancelled) return;
      for (const record of records) {
        if (record.type === 'characterData') {
          const node = record.target as Text;
          const tracked = texts.get(node);
          if (tracked && tracked.applied !== null && node.nodeValue === tracked.applied) continue; // our own write
          if (!tracked && !isTranslatableText((node.nodeValue || '').trim())) continue;
          scheduleScan(SCAN_DEBOUNCE_MS);
          return;
        }
        if (record.type === 'attributes') {
          const element = record.target as Element;
          const name = record.attributeName || '';
          const tracked = attributes.get(element)?.get(name);
          if (tracked && tracked.applied !== null && element.getAttribute(name) === tracked.applied) continue; // our own write
          scheduleScan(SCAN_DEBOUNCE_MS);
          return;
        }
        if (record.addedNodes.length > 0) {
          scheduleScan(SCAN_DEBOUNCE_MS);
          return;
        }
      }
    });

    // Every finished batch re-runs the scan, so results appear progressively.
    const unsubscribe = translator.subscribe(() => scheduleScan(0));

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRIBUTES
    });

    scan(); // start immediately on language selection - no second interaction needed

    return () => {
      cancelled = true;
      observer.disconnect();
      unsubscribe();
      if (scanTimer) clearTimeout(scanTimer);
      if (retryTimer) clearTimeout(retryTimer);
      restoreOriginals();
    };
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t, translateText }), [lang, setLang, t, translateText]);

  return React.createElement(LanguageContext.Provider, { value }, children);
};

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}