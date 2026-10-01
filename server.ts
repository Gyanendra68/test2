import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.js';
import { apiRouter } from './server/routes.js';
import { MAX_BATCH_SIZE, isSupportedTranslationLanguage, translateBatch, translateText } from './server/translation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // Initialize Relational Database & Seed Data
  await initDatabase();

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // Uploaded files static serve
  app.use('/uploads', express.static(path.resolve('uploads')));
  app.use(express.static(path.resolve('public')));

  // API router
  app.post('/api/translate', async (req, res) => {
    const { text, language } = req.body as { text?: unknown; language?: unknown };

    if (typeof text !== 'string' || !text.trim() || typeof language !== 'string' || !isSupportedTranslationLanguage(language)) {
      res.status(400).json({ error: 'A non-empty text and supported target language are required.' });
      return;
    }

    try {
      const result = await translateText(text, language);
      res.json(result);
    } catch (error) {
      // Translation must never break the app: fall back to the original text.
      console.error('[Translation] Unexpected error:', error);
      res.json({ text, cached: false, translated: false });
    }
  });

  // Batch endpoint used by the browser: many strings per HTTP request, while the
  // server still deduplicates, caches and paces the actual MyMemory calls.
  app.post('/api/translate/batch', async (req, res) => {
    const { texts, language } = req.body as { texts?: unknown; language?: unknown };

    if (
      !Array.isArray(texts) ||
      texts.length === 0 ||
      texts.length > MAX_BATCH_SIZE ||
      !texts.every((item) => typeof item === 'string') ||
      typeof language !== 'string' ||
      !isSupportedTranslationLanguage(language)
    ) {
      res.status(400).json({ error: `An array of 1-${MAX_BATCH_SIZE} strings and a supported target language are required.` });
      return;
    }

    try {
      res.json(await translateBatch(texts as string[], language));
    } catch (error) {
      console.error('[Translation] Unexpected batch error:', error);
      res.json({ language, translations: {} });
    }
  });
  app.use('/api', apiRouter);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'TribalScholar Backend', timestamp: new Date().toISOString() });
  });

  // Vite integration
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TribalScholar] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[TribalScholar] Failed to start server:', err);
  process.exit(1);
});