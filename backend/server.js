// server.js
// ============================================================
// Shatova API — Main Server
// ============================================================
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { env, logEnvSummary } from './env/env.js';
import { testConnection } from './config/database.js';

import authRoutes        from './routes/auth.routes.js';
import transactionRoutes from './routes/transaction.routes.js';
import dataRoutes        from './routes/data.routes.js';
import airtimeRoutes     from './routes/airtime.routes.js';
import walletRoutes      from './routes/wallet.routes.js';
import adminRoutes       from './routes/admin.routes.js';
import walletAdminRoutes from './routes/walletAdmin.routes.js';
import webhookRoutes     from './routes/webhook.routes.js';
import pricingRoutes     from './routes/pricing.routes.js';

import { startCatalogSyncJob }     from './jobs/catalogSync.job.js';
import { startAirtimeStatusJob }   from './jobs/airtime-status.job.js';
import { startDataStatusJob }      from './jobs/data-status.job.js';
import { startWalletReconcileJob } from './jobs/wallet-reconcile.job.js';
import { startMoneyAuditJob }      from './jobs/money-audit.job.js';

import { reconcileProcessingDataTransactions } from './services/data.service.js';
import { errorHandler, notFound } from './middleware/error.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FRONTEND   = path.join(__dirname, '../frontend');

const app = express();

/* ── CORS ───────────────────────────────────────────────── */
const allowedOrigins = [
  'http://localhost:3000', 'http://localhost:5000', 'http://localhost:6000',
  'http://127.0.0.1:3000', 'http://127.0.0.1:5000', 'http://127.0.0.1:6000',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:5500', 'http://127.0.0.1:5500',
  'https://shatova-data.onrender.com', 'https://shatova.com', 'https://www.shatova.com',
];

const allowedPatterns = [
  /\.devtunnels\.ms$/, /\.ngrok-free\.app$/, /\.app\.github\.dev$/,
  /\.onrender\.com$/, /\.railway\.app$/,
];

const isProd = process.env.NODE_ENV === 'production';
const blockedSeen = new Set();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (!isProd && allowedPatterns.some((rx) => rx.test(origin))) return cb(null, true);

    // ✅ FIXED #4: cap the set size so it can't grow unbounded on long-running servers
    if (blockedSeen.size < 1000 && !blockedSeen.has(origin)) {
      blockedSeen.add(origin);
      console.warn(`[cors] blocked origin: ${origin}`);
    }
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

/* ── Security & Parsing ─────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

/* ── HTTP logging ───────────────────────────────────────── */
const LOG_HTTP = (process.env.LOG_HTTP || 'false').toLowerCase();
if (LOG_HTTP === 'true') {
  app.use(morgan(env.isDev ? 'dev' : 'combined'));
} else if (LOG_HTTP === 'errors') {
  app.use(morgan('tiny', { skip: (req, res) => res.statusCode < 400 }));
}

/* ── Health ─────────────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'Shatova API', env: isProd ? 'prod' : 'dev', ts: new Date().toISOString() });
});

/* ════════════════════════════════════════════════════════════
   PWA FILES
   ════════════════════════════════════════════════════════════ */

// ✅ FIXED #2: cache manifest for 1 hour; keep SW uncached so updates land fast
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(FRONTEND, 'manifest.webmanifest'));
});

app.get('/service-worker.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache'); // browser revalidates each load
  res.sendFile(path.join(FRONTEND, 'service-worker.js'));
});

app.get('/offline.html', (req, res) => {
  res.sendFile(path.join(FRONTEND, 'offline.html'));
});

// ✅ FIXED #5: explicit route for Android TWA verification (see notes below).
// If you're NOT shipping an Android TWA, you can delete this block safely.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(FRONTEND, '.well-known/assetlinks.json'));
});
/* ════════════════════════════════════════════════════════════ */

/* ── API Routes ─────────────────────────────────────────── */
app.use('/api/v1/auth',         authRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/data',         dataRoutes);
app.use('/api/v1/airtime',      airtimeRoutes);
app.use('/api/v1/wallet/admin', walletAdminRoutes);
app.use('/api/v1/wallet',       walletRoutes);
app.use('/api/v1/admin',        adminRoutes);
app.use('/api/v1/webhooks',     webhookRoutes);
app.use('/api/v1/admin/pricing', pricingRoutes);

/* ── Default landing — BEFORE static ────────────────────── */
app.get('/',           (req, res) => res.redirect('/pin.html'));
app.get('/index.html', (req, res) => res.redirect('/pin.html'));
app.get('/index',      (req, res) => res.redirect('/pin.html'));

/* ── Static assets — after redirects ────────────────────── */
app.use(express.static(FRONTEND, { index: false }));

/* ✅ FIXED #1: page() routes removed.
   express.static above already serves every .html file in FRONTEND/.
   The old page() handlers were dead code — this keeps the file honest.
   If you later want clean URLs without .html, add rewrites like:
     app.get('/login', (req, res) => res.sendFile(path.join(FRONTEND, 'login.html')));
   BEFORE the express.static line. */

/* ── Errors ─────────────────────────────────────────────── */
app.use(notFound);
app.use(errorHandler);

/* ════════════════════════════════════════════════════════════
   ERROR HELPERS
   ════════════════════════════════════════════════════════════ */
function logFatal(label, err) {
  console.error('══════════════════════════════════════════════════');
  console.error(label);
  console.error('══════════════════════════════════════════════════');
  console.error('message :', err?.message || '(empty)');
  console.error('code    :', err?.code);
  console.error('name    :', err?.name);
  console.error('stack   :');
  console.error(err?.stack || '(no stack)');
  console.error('══════════════════════════════════════════════════');
}

/* ── DB URL diagnostic ──────────────────────────────────── */
function logDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('[start] ❌ DATABASE_URL is not set');
    return;
  }
  try {
    const u = new URL(raw);
    console.log('[start] DB host :', u.hostname);
    console.log('[start] DB port :', u.port || '5432');
    console.log('[start] DB name :', u.pathname.slice(1));
    console.log('[start] DB user :', u.username);
    console.log('[start] DB proto:', u.protocol);
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname);
    if (isLocal) {
      console.error('[start] ⚠ DATABASE_URL points to LOCALHOST — Render cannot reach this.');
      console.error('[start] ⚠ Set DATABASE_URL to your Render Postgres Internal URL.');
    }
  } catch (e) {
    console.error('[start] ❌ DATABASE_URL is not a valid URL:', raw);
  }
}

/* ── Start ──────────────────────────────────────────────── */
async function start() {
  try {
    console.log('[start] ▶ booting server.js');
    console.log('[start] NODE_ENV :', process.env.NODE_ENV);
    console.log('[start] PORT     :', process.env.PORT || '(default)');
    console.log('[start] ▶ DB config:');
    logDbUrl();

    console.log('[start] ▶ testing DB connection…');
    await testConnection();
    console.log('[start] ✅ DB connected');

    console.log('[start] ▶ logging env summary…');
    logEnvSummary();
    console.log('[start] ✅ env summary ok');

    const port = env.PORT || process.env.PORT || 3000;
    const server = app.listen(port, () => {
      console.log(`[start] ✅ Shatova API listening on http://localhost:${port}`);
      console.log(`[start]   HTTP logs:  ${LOG_HTTP}`);
      console.log(`[start]   CORS mode:  ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    });

    console.log('[start] ▶ starting background jobs…');
    startCatalogSyncJob();
    startAirtimeStatusJob();
    startDataStatusJob();
    startWalletReconcileJob();
    startMoneyAuditJob();
    console.log('[start] ✅ background jobs started');

    const runDataReconciler = async () => {
      try { await reconcileProcessingDataTransactions(50); }
      catch (e) { console.error('[data-reconcile] tick error:', e.message); }
    };
    setInterval(runDataReconciler, 60_000);
    setTimeout(runDataReconciler, 15_000);
    console.log('[start] ✅ data reconciler scheduled every 60s');

    const shutdown = (signal) => {
      console.log(`\n[shutdown] ${signal} received, shutting down...`);
      server.close(() => process.exit(0));
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('[start] ✅ boot complete');
  } catch (err) {
    logFatal('STARTUP FAILED', err);
    process.exit(1);
  }
}

/* ════════════════════════════════════════════════════════════
   GLOBAL HANDLERS
   ════════════════════════════════════════════════════════════ */
process.on('unhandledRejection', (reason) => {
  logFatal('UNHANDLED PROMISE REJECTION', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err) => {
  logFatal('UNCAUGHT EXCEPTION', err);
  process.exit(1);
});

start();