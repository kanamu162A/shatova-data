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
    if (!blockedSeen.has(origin)) {
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

/* ── Page routes ────────────────────────────────────────── */
const page = (name) => (req, res) => res.sendFile(path.join(FRONTEND, name));

app.get('/pin.html',             page('pin.html'));
app.get('/pin',                  page('pin.html'));
app.get('/login.html',           page('login.html'));
app.get('/login',                page('login.html'));
app.get('/register.html',        page('register.html'));
app.get('/register',             page('register.html'));
app.get('/home.html',            page('home.html'));
app.get('/home',                 page('home.html'));
app.get('/dashboard',            page('home.html'));
app.get('/profile.html',         page('profile.html'));
app.get('/profile',              page('profile.html'));
app.get('/data.html',            page('data.html'));
app.get('/airtime.html',         page('airtime.html'));
app.get('/electricity.html',     page('electricity.html'));
app.get('/tv.html',              page('tv.html'));
app.get('/exam.html',            page('exam.html'));
app.get('/airtime-to-cash.html', page('airtime-to-cash.html'));
app.get('/transactions.html',    page('transactions.html'));
app.get('/transactions',         page('transactions.html'));
app.get('/wallet.html',          page('wallet.html'));
app.get('/fund-wallet.html',     page('fund-wallet.html'));
app.get('/transfer.html',        page('transfer.html'));
app.get('/settings.html',        page('settings.html'));
app.get('/settings',             page('settings.html'));
app.get('/support.html',         page('support.html'));
app.get('/support',              page('support.html'));
app.get('/notifications.html',   page('notifications.html'));
app.get('/terms.html',           page('terms.html'));
app.get('/pricing.html',         page('pricing.html'));
app.get('/pricing',              page('pricing.html'));
app.get('/admin.html',           page('admin.html'));
app.get('/admin',                page('admin.html'));

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
  console.error('detail  :', err?.detail);
  console.error('hint    :', err?.hint);
  console.error('context :', err?.context);
  console.error('status  :', err?.statusCode);
  console.error('stack   :');
  console.error(err?.stack || '(no stack)');
  console.error('--- env snapshot ---');
  console.error('NODE_ENV    :', process.env.NODE_ENV);
  console.error('PORT        :', process.env.PORT);
  console.error('DATABASE_URL:', process.env.DATABASE_URL ? '<set>' : '<MISSING>');
  console.error('JWT_SECRET  :', process.env.JWT_SECRET ? '<set>' : '<MISSING>');
  console.error('VTU_API_KEY :', process.env.VTU_API_KEY ? '<set>' : '<MISSING>');
  console.error('══════════════════════════════════════════════════');
}

/* ── Start ──────────────────────────────────────────────── */
async function start() {
  try {
    console.log('[start] ▶ booting server.js');
    console.log('[start] NODE_ENV :', process.env.NODE_ENV);
    console.log('[start] PORT     :', process.env.PORT || '(default)');
    console.log('[start] DB URL   :', process.env.DATABASE_URL ? '<set>' : '<MISSING>');

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