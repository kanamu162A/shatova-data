// jobs/wallet-reconcile.job.js
// ============================================================
// Wallet health job
//   1. Wallet drift detection
//   2. Negative balance check
//   ⭐ Stuck DATA tx recovery handled by data.service.js
// ============================================================
import cron from 'node-cron';
import { query } from '../config/database.js';

const AUTO_REPAIR = process.env.WALLET_AUTO_REPAIR === 'true';

export async function reconcileWallets() {
  try {
    const { rows: drift } = await query(`
      WITH last_settled AS (
        SELECT DISTINCT ON (wallet_id)
              wallet_id, balance_after
          FROM wallet_ledger
        WHERE type NOT IN ('HOLD', 'HOLD_RELEASE')
        ORDER BY wallet_id, created_at DESC, id DESC
      )
      SELECT
        w.id                          AS wallet_id,
        w.user_id,
        u.email,
        w.balance                     AS wallet_balance,
        w.held_balance                AS wallet_held_balance,
        COALESCE(ls.balance_after, 0) AS ledger_balance,
        (w.balance - COALESCE(ls.balance_after, 0)) AS drift
      FROM wallets w
      LEFT JOIN last_settled ls ON ls.wallet_id = w.id
      LEFT JOIN users         u  ON u.id = w.user_id
      WHERE w.balance IS DISTINCT FROM COALESCE(ls.balance_after, 0)
    `);

    if (drift.length && AUTO_REPAIR) {
      for (const d of drift) {
        await query(
          `UPDATE wallets
              SET balance = $1,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $2`,
          [Number(d.ledger_balance), d.wallet_id]
        );
      }
      console.warn(`[reconcile] snapped ${drift.length} wallet(s) to expected balance`);
    } else if (drift.length) {
      for (const d of drift) {
        console.warn(
          `[reconcile] DRIFT wallet=${d.wallet_id} user=${d.user_id} ` +
          `wallet=₦${Number(d.wallet_balance).toFixed(2)} ` +
          `ledger=₦${Number(d.ledger_balance).toFixed(2)} ` +
          `diff=₦${Number(d.drift).toFixed(2)}`
        );
      }
    }

    const { rows: negative } = await query(
      `SELECT id, user_id, balance FROM wallets WHERE balance < 0 LIMIT 20`
    );
    if (negative.length) {
      console.error(`[reconcile] CRITICAL: ${negative.length} wallet(s) with negative balance`);
    }

    return { ok: true, drift: drift.length, snapped: AUTO_REPAIR ? drift.length : 0 };
  } catch (err) {
    console.error('[reconcile] error:', err.message);
    return { ok: false, error: err.message };
  }
}

export function startWalletReconcileJob() {
  cron.schedule('*/2 * * * *', reconcileWallets, { timezone: 'Africa/Lagos' });
  console.log(`[reconcile] wallet drift job scheduled every 2 min (auto-repair: ${AUTO_REPAIR ? 'ON' : 'OFF'})`);
  setTimeout(reconcileWallets, 5_000);
}

export default { reconcileWallets, startWalletReconcileJob };