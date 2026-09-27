// jobs/daily-transaction-archive.job.js
// ============================================================
// Shatova — Daily transaction archive
//   • Runs at 00:00 Africa/Lagos every day
//   • Archives ALL transactions to CSV file + archive table
//   • Keeps only the last N transactions per user in the live
//     transactions table (older ones live in transactions_archive
//     and on disk)
//   • NEVER deletes unless BOTH file write and archive insert
//     succeeded
// ============================================================

import cron from 'node-cron';
import fs   from 'node:fs/promises';
import path from 'node:path';
import { query, withTransaction } from '../config/database.js';

const ARCHIVE_DIR      = process.env.ARCHIVE_DIR || './archives/transactions';
const KEEP_PER_USER    = Number(process.env.ARCHIVE_KEEP_PER_USER) || 5;
const ARCHIVE_ON_BOOT  = process.env.ARCHIVE_ON_BOOT === 'true';

let running = false;

/* ============================================================
   CSV helper
   ============================================================ */
function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const header = columns.join(',');
  const lines  = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return header + '\n' + lines.join('\n');
}

async function ensureArchiveDir() {
  try {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/* ============================================================
   Main job
   ============================================================ */
export async function archiveAndTrimTransactions() {
  if (running) {
    console.warn('[archive] already running — skipping this cycle');
    return { ok: false, reason: 'already_running' };
  }
  running = true;

  const startedAt = Date.now();
  console.log('[archive] ═══ starting daily archive ═══');

  try {
    /* ── STEP A: Ensure directory exists ── */
    await ensureArchiveDir();

    /* ── STEP B: Fetch ALL transactions ── */
    const { rows } = await query(
      `SELECT id, user_id, reference, type, service, direction,
              amount, status, description, metadata, network,
              cost_price, profit, provider_reference,
              created_at, updated_at
         FROM transactions
        ORDER BY created_at ASC`
    );

    if (!rows.length) {
      console.log('[archive] no transactions to archive');
      return { ok: true, total: 0, archived: 0, deleted: 0 };
    }

    console.log(`[archive] fetched ${rows.length} rows`);

    /* ── STEP C: Write CSV file ── */
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, '-');
    const filename = `transactions-${stamp}.csv`;
    const filepath = path.join(ARCHIVE_DIR, filename);

    const columns = [
      'id', 'user_id', 'reference', 'type', 'service', 'direction',
      'amount', 'status', 'description', 'metadata', 'network',
      'cost_price', 'profit', 'provider_reference',
      'created_at', 'updated_at',
    ];
    const csv = toCsv(rows, columns);
    await fs.writeFile(filepath, csv, 'utf8');
    console.log(`[archive] ✅ wrote file: ${filepath} (${rows.length} rows)`);

    /* ── STEP D: Insert into transactions_archive ── */
    let archived = 0;
    await withTransaction(async (client) => {
      for (const r of rows) {
        try {
          await client.query(
            `INSERT INTO transactions_archive
               (original_id, user_id, reference, type, service, direction,
                amount, status, description, metadata, network,
                cost_price, profit, provider_reference,
                original_created_at, original_updated_at, archived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                     $12, $13, $14, $15, $16, NOW())
             ON CONFLICT (reference) DO NOTHING`,
            [
              r.id, r.user_id, r.reference, r.type, r.service, r.direction,
              r.amount, r.status, r.description,
              JSON.stringify(r.metadata || {}),
              r.network, r.cost_price, r.profit, r.provider_reference,
              r.created_at, r.updated_at,
            ]
          );
          archived++;
        } catch (err) {
          console.warn(`[archive] insert failed for ${r.reference}:`, err.message);
        }
      }
    });
    console.log(`[archive] ✅ inserted ${archived}/${rows.length} rows into transactions_archive`);

    /* ── SAFETY GATE ── */
    if (archived < rows.length) {
      const missed = rows.length - archived;
      throw new Error(
        `Archive incomplete: ${missed} rows failed to insert. ` +
        `Aborting trim to prevent data loss.`
      );
    }

    /* ── STEP E: Trim — keep last N per user ── */
    const { rowCount: deleted } = await query(
      `DELETE FROM transactions
        USING (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id
                     ORDER BY created_at DESC, id DESC
                   ) AS rn
              FROM transactions
          ) ranked
          WHERE rn > $1
        ) old
        WHERE transactions.id = old.id
          AND UPPER(transactions.status) NOT IN ('PENDING', 'PROCESSING')`,
      [KEEP_PER_USER]
    );
    console.log(`[archive] ✅ deleted ${deleted} old rows (kept ${KEEP_PER_USER} per user)`);

    const elapsed = Date.now() - startedAt;
    console.log(`[archive] ═══ done in ${elapsed}ms ═══`);

    return {
      ok: true,
      total: rows.length,
      archived,
      deleted,
      file: filepath,
      elapsed,
    };

  } catch (err) {
    console.error('[archive] ❌ ABORTED:', err.message);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

/* ============================================================
   Scheduler
   ============================================================ */
export function startDailyTransactionArchiveJob() {
  /* Every day at 00:00 Africa/Lagos */
  cron.schedule('0 0 * * *', () => {
    archiveAndTrimTransactions().catch((err) => {
      console.error('[archive] unhandled:', err);
    });
  }, { timezone: 'Africa/Lagos' });

  console.log('[archive] scheduled daily at 00:00 Africa/Lagos');

  if (ARCHIVE_ON_BOOT) {
    setTimeout(() => {
      archiveAndTrimTransactions().catch((err) => {
        console.error('[archive] boot-run error:', err);
      });
    }, 30_000);
  }
}

export default {
  archiveAndTrimTransactions,
  startDailyTransactionArchiveJob,
};