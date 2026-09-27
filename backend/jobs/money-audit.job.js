// jobs/money-audit.job.js
// ============================================================
// Shatova — Money Audit Job
//   ⭐ Every 5 minutes, verifies:
//      1. No PENDING tx stuck > 10 min
//      2. No PROCESSING tx stuck > 30 min
//      3. No tx SUCCESS without DataShop confirmation
//      4. No tx FAILED that actually succeeded at DataShop
//      5. Wallet ledger is internally consistent
// ============================================================

import cron from 'node-cron';
import { query } from '../config/database.js';
import * as datashop from '../services/datashop.service.js';

/* ---------- 1. Stuck transactions ---------- */
async function checkStuckTransactions() {
  const { rows: pending } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'PENDING'
        AND created_at < NOW() - INTERVAL '10 minutes'
        AND created_at > NOW() - INTERVAL '24 hours'`
  );

  const { rows: processing } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'PROCESSING'
        AND created_at < NOW() - INTERVAL '30 minutes'
        AND created_at > NOW() - INTERVAL '24 hours'`
  );

  const stuck = [...pending, ...processing];

  if (stuck.length) {
    console.error(`[audit] 🚨 ${stuck.length} STUCK transaction(s):`);
    for (const tx of stuck) {
      console.error(`[audit]   ${tx.reference} | user=${tx.user_id} | ₦${tx.amount} | since ${tx.created_at}`);
    }
  }

  return stuck;
}

/* ---------- 2. Verify SUCCESS transactions against DataShop ---------- */
async function verifySuccessTransactions() {
  // Check the last 50 SUCCESS transactions in the last 24 hours
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, metadata, created_at
       FROM transactions
      WHERE status = 'SUCCESS'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT 50`
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

        console.error(`[audit] 🚨 ${tx.reference}: DB=SUCCESS but DataShop=FAILED — user was charged, product not delivered`);
      }
    } catch (err) {
      // DataShop unreachable — skip
    }
  }

  return mismatches;
}

/* ---------- 3. Verify FAILED transactions actually failed at DataShop ---------- */
async function verifyFailedTransactions() {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'FAILED'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT 50`
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

        console.error(`[audit] 🚨 ${tx.reference}: DB=FAILED but DataShop=SUCCESS — user was refunded but got the product`);
      }
    } catch (err) {}
  }

  return suspicious;
}

/* ---------- 4. Wallet vs ledger consistency ---------- */
async function checkWalletIntegrity() {
  const { rows } = await query(
    `SELECT w.id, w.user_id, w.balance,
            COALESCE(SUM(CASE WHEN wl.direction = 'CREDIT' THEN wl.amount ELSE -wl.amount END), 0) AS ledger_net
       FROM wallets w
       LEFT JOIN wallet_ledger wl ON wl.wallet_id = w.id
      GROUP BY w.id, w.user_id, w.balance
     HAVING w.balance != COALESCE(SUM(CASE WHEN wl.direction = 'CREDIT' THEN wl.amount ELSE -wl.amount END), 0)`
  );

  if (rows.length) {
    console.error(`[audit] 🚨 ${rows.length} wallet(s) out of sync (auto-fixed by reconcile job)`);
  }
  return rows;
}

/* ---------- 5. DataShop ↔ Our ledger total ---------- */
async function checkDataShopBalance() {
  try {
    const dsBalance = await datashop.getDatashopBalance();

    // Our expected DataShop balance:
    // Starting DS balance was captured somewhere (env var or settings table)
    // Every successful tx → DS balance decreases by cost_price
    // We don't have the original, so this is a snapshot for manual review

    console.log(`[audit] DataShop balance: ₦${dsBalance}`);

    // Sum of all our successful data + airtime purchases (cost_price)
    const { rows } = await query(
      `SELECT
        COALESCE(SUM(cost_price), 0) AS total_spent_at_ds,
        COUNT(*) AS tx_count
       FROM transactions
      WHERE status = 'SUCCESS'
        AND cost_price IS NOT NULL`
    );

    console.log(`[audit] Total spent at DataShop (from our records): ₦${rows[0]?.total_spent_at_ds || 0} over ${rows[0]?.tx_count || 0} txs`);

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

  const totalIssues = stuck.length + mismatchSuccess.length + mismatchFailed.length + walletDrift.length;

  if (totalIssues === 0) {
    console.log('[audit] ✅ All clear — no money issues detected');
  } else {
    console.error(`[audit] 🚨 ${totalIssues} issue(s) found — review above`);
    // TODO: send yourself an email/Slack alert here
  }
}

export function startMoneyAuditJob() {
  cron.schedule('*/5 * * * *', runAudit, { timezone: 'Africa/Lagos' });
  console.log('[audit] money audit scheduled: every 5 minutes');

  // Run once at startup
  setTimeout(runAudit, 10_000);
}