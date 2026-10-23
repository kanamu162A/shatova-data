// jobs/money-audit.job.js
// ============================================================
// Shatova — Money Audit Job (egress-friendly)
//   Runs 3× daily. Caps external API calls and DB scans.
// ============================================================
import cron from 'node-cron';
import { query } from '../config/database.js';
import * as datashop from '../services/datashop.service.js';

const MAX_DS_CHECKS = 10; // max DataShop status lookups per run

/* ---------- 1. Stuck transactions (local only) ---------- */
async function checkStuckTransactions() {
  const { rows: pending } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'PENDING'
        AND created_at < NOW() - INTERVAL '10 minutes'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
      LIMIT 50`
  );

  const { rows: processing } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'PROCESSING'
        AND created_at < NOW() - INTERVAL '30 minutes'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
      LIMIT 50`
  );

  const stuck = [...pending, ...processing];
  if (stuck.length) {
    console.error(`[audit] 🚨 ${stuck.length} STUCK transaction(s):`);
    for (const tx of stuck) {
      console.error(
        `[audit]   ${tx.reference} | user=${tx.user_id} | ₦${tx.amount} | since ${tx.created_at}`
      );
    }
  }
  return stuck;
}

/* ---------- 2. Sample SUCCESS vs DataShop (capped) ---------- */
async function verifySuccessTransactions() {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, metadata, created_at
       FROM transactions
      WHERE status = 'SUCCESS'
        AND created_at > NOW() - INTERVAL '6 hours'
      ORDER BY created_at DESC
      LIMIT ${MAX_DS_CHECKS}`
  );

  const mismatches = [];
  for (const tx of rows) {
    try {
      const ds = await datashop.checkTransactionStatus(tx.reference);
      const status = datashop.normalizeProviderStatus(ds);
      if (status === 'failed') {
        mismatches.push({
          reference: tx.reference,
          user_id:   tx.user_id,
          amount:    tx.amount,
          issue:     'DB says SUCCESS but DataShop says FAILED',
        });
        console.error(`[audit] 🚨 ${tx.reference}: DB=SUCCESS but DataShop=FAILED`);
      }
    } catch (_) {
      // DataShop unreachable — skip
    }
  }
  return mismatches;
}

/* ---------- 3. Sample FAILED vs DataShop (capped) ---------- */
async function verifyFailedTransactions() {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'FAILED'
        AND created_at > NOW() - INTERVAL '6 hours'
      ORDER BY created_at DESC
      LIMIT ${MAX_DS_CHECKS}`
  );

  const suspicious = [];
  for (const tx of rows) {
    try {
      const ds = await datashop.checkTransactionStatus(tx.reference);
      const status = datashop.normalizeProviderStatus(ds);
      if (status === 'successful') {
        suspicious.push({
          reference: tx.reference,
          user_id:   tx.user_id,
          amount:    tx.amount,
          issue:     'DB says FAILED but DataShop says SUCCESS',
        });
        console.error(`[audit] 🚨 ${tx.reference}: DB=FAILED but DataShop=SUCCESS`);
      }
    } catch (_) {}
  }
  return suspicious;
}

/* ---------- 4. Wallet vs last ledger row (cheap) ---------- */
async function checkWalletIntegrity() {
  const { rows } = await query(`
    WITH last_ledger AS (
      SELECT DISTINCT ON (wallet_id)
            wallet_id, balance_after
        FROM wallet_ledger
       WHERE LOWER(COALESCE(status, 'successful')) NOT IN ('pending', 'processing')
       ORDER BY wallet_id, created_at DESC, id DESC
    )
    SELECT
      w.id AS wallet_id,
      w.user_id,
      w.balance,
      COALESCE(ll.balance_after, 0) AS ledger_balance,
      (w.balance - COALESCE(ll.balance_after, 0)) AS drift
    FROM wallets w
    LEFT JOIN last_ledger ll ON ll.wallet_id = w.id
    WHERE w.balance IS DISTINCT FROM COALESCE(ll.balance_after, 0)
    ORDER BY ABS(w.balance - COALESCE(ll.balance_after, 0)) DESC
    LIMIT 50
  `);

  if (rows.length) {
    console.error(
      `[audit] 🚨 ${rows.length} wallet(s) out of sync (reconcile job handles repair)`
    );
  }
  return rows;
}

/* ---------- 5. DataShop balance snapshot (24h only) ---------- */
async function checkDataShopBalance() {
  try {
    const dsBalance = await datashop.getDatashopBalance();
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(cost_price), 0) AS total_spent_at_ds,
         COUNT(*)::int AS tx_count
       FROM transactions
      WHERE status = 'SUCCESS'
        AND cost_price IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'`
    );
    console.log(`[audit] DataShop balance: ₦${dsBalance}`);
    console.log(
      `[audit] Spent at DS (24h): ₦${rows[0]?.total_spent_at_ds || 0} over ${rows[0]?.tx_count || 0} txs`
    );
    return { dsBalance, ourRecords: rows[0] };
  } catch (err) {
    console.warn('[audit] Could not fetch DataShop balance:', err.message);
    return null;
  }
}

/* ---------- RUN ---------- */
async function runAudit() {
  console.log('[audit] 🔍 Running money audit…');
  const stuck = await checkStuckTransactions();
  const mismatchSuccess = await verifySuccessTransactions();
  const mismatchFailed = await verifyFailedTransactions();
  const walletDrift = await checkWalletIntegrity();
  await checkDataShopBalance();

  const totalIssues =
    stuck.length + mismatchSuccess.length + mismatchFailed.length + walletDrift.length;

  if (totalIssues === 0) {
    console.log('[audit] ✅ All clear — no money issues detected');
  } else {
    console.error(`[audit] 🚨 ${totalIssues} issue(s) found — review above`);
  }
}

export function startMoneyAuditJob() {
  // 3× per day: 08:00, 14:00, 20:00 Africa/Lagos
  cron.schedule('0 8,14,20 * * *', runAudit, { timezone: 'Africa/Lagos' });
  console.log('[audit] money audit scheduled: 3× daily (08:00, 14:00, 20:00 WAT)');
  // First run 5 minutes after boot
  setTimeout(runAudit, 5 * 60_000);
}

export default { startMoneyAuditJob, runAudit };
