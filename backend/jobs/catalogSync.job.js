// jobs/catalogSync.job.js
// ============================================================
// Shatova — Catalog Sync Cron
// ============================================================

import cron from 'node-cron';
import { query } from '../config/database.js';
import * as catalog from '../services/catalog.service.js';

let isSyncing = false;

async function hasRecentPendingTx() {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n
       FROM transactions
       WHERE status IN ('PENDING','PROCESSING')
         AND created_at > NOW() - INTERVAL '30 seconds'`
    );
    return (r.rows[0]?.n || 0) > 0;
  } catch {
    return false;
  }
}

async function runSync(reason = 'scheduled') {
  if (isSyncing) {
    console.log(`[cron] sync already running, skipping (${reason})`);
    return;
  }

  if (await hasRecentPendingTx()) {
    console.log('[cron] recent pending tx detected, deferring 30s');
    setTimeout(() => runSync('deferred'), 30_000);
    return;
  }

  isSyncing = true;
  const startedAt = Date.now();
  console.log(`[cron] starting catalog sync (${reason})...`);

  try {
    const dataResults = await catalog.syncAllDataProviders();
    const ms = Date.now() - startedAt;

    const dataSummary = dataResults
      .map((d) => (d.error ? `${d.provider}:ERR` : `${d.provider}:${d.updated}U/${d.inserted}I`))
      .join(' ');

    console.log(`[cron] sync done in ${ms}ms`);
    console.log(`[cron]   data    → ${dataSummary}`);
  } catch (err) {
    console.error('[cron] sync failed:', err.message);
  } finally {
    isSyncing = false;
  }
}

export function startCatalogSyncJob() {
  cron.schedule('*/30 * * * *', () => runSync('scheduled'), {
    scheduled: true,
    timezone: 'Africa/Lagos',
  });

  console.log('[cron] catalog sync scheduled: every 30 minutes');
  setTimeout(() => runSync('startup'), 5_000);
}