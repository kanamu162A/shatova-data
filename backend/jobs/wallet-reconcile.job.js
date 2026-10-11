// jobs/wallet-reconcile.job.js
// ============================================================
// Wallet health job
//   1. Balance drift (wallet.balance vs last ledger balance_after)
//   2. Held-balance drift (wallet.held_balance vs open HELD holds)
//   3. Negative balance / held checks
//   4. Optional auto-repair (WALLET_AUTO_REPAIR=true)
//
// IMPORTANT: Do NOT ignore HOLD / HOLD_RELEASE ledger rows.
//   place() writes HOLD with the post-hold balance_after.
//   Ignoring HOLD makes every in-flight purchase look like drift.
// ============================================================
import cron from 'node-cron';
import { query } from '../config/database.js';

const AUTO_REPAIR = process.env.WALLET_AUTO_REPAIR === 'true';

export async function reconcileWallets() {
  try {
    // ── 1) Spendable balance drift ────────────────────────────
    // Last ledger row (any type) is the source of truth for balance_after.
    const { rows: drift } = await query(`
      WITH last_ledger AS (
        SELECT DISTINCT ON (wallet_id)
              wallet_id, balance_after, type, created_at, id
          FROM wallet_ledger
         ORDER BY wallet_id, created_at DESC, id DESC
      )
      SELECT
        w.id                          AS wallet_id,
        w.user_id,
        u.email,
        w.balance                     AS wallet_balance,
        w.held_balance                AS wallet_held_balance,
        COALESCE(ll.balance_after, 0) AS ledger_balance,
        ll.type                       AS last_ledger_type,
        (w.balance - COALESCE(ll.balance_after, 0)) AS drift
      FROM wallets w
      LEFT JOIN last_ledger ll ON ll.wallet_id = w.id
      LEFT JOIN users u ON u.id = w.user_id
      WHERE w.balance IS DISTINCT FROM COALESCE(ll.balance_after, 0)
    `);

    let snapped = 0;
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
        snapped++;
        console.warn(
          `[reconcile] SNAP balance wallet=${d.wallet_id} user=${d.user_id} ` +
          `wallet=₦${Number(d.wallet_balance).toFixed(2)} → ledger=₦${Number(d.ledger_balance).toFixed(2)} ` +
          `(last=${d.last_ledger_type})`
        );
      }
    } else if (drift.length) {
      for (const d of drift) {
        console.warn(
          `[reconcile] DRIFT balance wallet=${d.wallet_id} user=${d.user_id} ` +
          `wallet=₦${Number(d.wallet_balance).toFixed(2)} ` +
          `ledger=₦${Number(d.ledger_balance).toFixed(2)} ` +
          `diff=₦${Number(d.drift).toFixed(2)} last=${d.last_ledger_type || 'none'}`
        );
      }
    }

    // ── 2) Held-balance vs open HELD rows ─────────────────────
    // wallet.held_balance must equal SUM(amount) of status='HELD'
    const { rows: heldDrift } = await query(`
      SELECT
        w.id AS wallet_id,
        w.user_id,
        w.held_balance AS wallet_held,
        COALESCE(h.open_held, 0) AS open_held,
        (COALESCE(w.held_balance, 0) - COALESCE(h.open_held, 0)) AS held_drift
      FROM wallets w
      LEFT JOIN (
        SELECT wallet_id, SUM(amount)::numeric AS open_held
          FROM wallet_holds
         WHERE status = 'HELD'
         GROUP BY wallet_id
      ) h ON h.wallet_id = w.id
      WHERE COALESCE(w.held_balance, 0) IS DISTINCT FROM COALESCE(h.open_held, 0)
    `);

    let heldSnapped = 0;
    if (heldDrift.length && AUTO_REPAIR) {
      for (const d of heldDrift) {
        await query(
          `UPDATE wallets
              SET held_balance = $1,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $2`,
          [Number(d.open_held), d.wallet_id]
        );
        heldSnapped++;
        console.warn(
          `[reconcile] SNAP held wallet=${d.wallet_id} user=${d.user_id} ` +
          `held=₦${Number(d.wallet_held).toFixed(2)} → open_holds=₦${Number(d.open_held).toFixed(2)}`
        );
      }
    } else if (heldDrift.length) {
      for (const d of heldDrift) {
        console.warn(
          `[reconcile] DRIFT held wallet=${d.wallet_id} user=${d.user_id} ` +
          `wallet_held=₦${Number(d.wallet_held).toFixed(2)} ` +
          `open_holds=₦${Number(d.open_held).toFixed(2)} ` +
          `diff=₦${Number(d.held_drift).toFixed(2)}`
        );
      }
    }

    // ── 3) Negative balances (critical) ───────────────────────
    const { rows: negative } = await query(
      `SELECT id, user_id, balance, held_balance
         FROM wallets
        WHERE balance < 0 OR held_balance < 0
        LIMIT 50`
    );
    if (negative.length) {
      for (const n of negative) {
        console.error(
          `[reconcile] CRITICAL negative wallet=${n.id} user=${n.user_id} ` +
          `balance=₦${Number(n.balance).toFixed(2)} held=₦${Number(n.held_balance || 0).toFixed(2)}`
        );
      }
    }

    // ── 4) Orphan HELD holds (tx already SUCCESS/FAILED) ──────
    // If hold is still HELD but transaction is final, held_balance is wrong.
    const { rows: orphanHolds } = await query(`
      SELECT h.id AS hold_id, h.wallet_id, h.transaction_id, h.amount,
             t.reference, t.status AS tx_status
        FROM wallet_holds h
        JOIN transactions t ON t.id = h.transaction_id
       WHERE h.status = 'HELD'
         AND UPPER(t.status) IN ('SUCCESS', 'FAILED', 'REFUNDED')
       ORDER BY h.created_at ASC
       LIMIT 100
    `);

    let orphansFixed = 0;
    if (orphanHolds.length) {
      for (const h of orphanHolds) {
        const txSt = String(h.tx_status || '').toUpperCase();
        const newHoldStatus = txSt === 'SUCCESS' ? 'DEBITED' : 'RELEASED';

        if (AUTO_REPAIR) {
          // Align hold row
          await query(
            `UPDATE wallet_holds
                SET status = $1, updated_at = NOW()
              WHERE id = $2 AND status = 'HELD'`,
            [newHoldStatus, h.hold_id]
          );

          // Recompute held_balance from remaining open holds
          await query(
            `UPDATE wallets w
                SET held_balance = COALESCE((
                      SELECT SUM(amount) FROM wallet_holds
                       WHERE wallet_id = w.id AND status = 'HELD'
                    ), 0),
                    version = version + 1,
                    updated_at = NOW()
              WHERE w.id = $1`,
            [h.wallet_id]
          );

          // If FAILED/REFUNDED and money was never returned, credit balance back
          // Only when hold was still HELD (money still locked) — SUCCESS should not credit.
          if (txSt === 'FAILED' || txSt === 'REFUNDED') {
            await query(
              `UPDATE wallets
                  SET balance = balance + $1,
                      version = version + 1,
                      updated_at = NOW()
                WHERE id = $2`,
              [Number(h.amount), h.wallet_id]
            );
            // Ledger trail for audit
            await query(
              `INSERT INTO wallet_ledger
                 (wallet_id, user_id, transaction_id, reference, type, direction,
                  amount, balance_before, balance_after, description,
                  status, metadata, created_at, updated_at)
               SELECT w.id, w.user_id, $1, $2, 'HOLD_RELEASE', 'CREDIT',
                      $3, w.balance - $3, w.balance,
                      'Auto-repair: orphan hold released after tx ' || $4,
                      'SUCCESS', '{}'::jsonb, NOW(), NOW()
                 FROM wallets w WHERE w.id = $5`,
              [h.transaction_id, h.reference, Number(h.amount), txSt, h.wallet_id]
            );
          }

          orphansFixed++;
          console.warn(
            `[reconcile] ORPHAN hold fixed hold=${h.hold_id} tx=${h.reference} ` +
            `${txSt} → hold=${newHoldStatus}`
          );
        } else {
          console.warn(
            `[reconcile] ORPHAN hold hold=${h.hold_id} wallet=${h.wallet_id} ` +
            `tx=${h.reference} status=${txSt} amount=₦${Number(h.amount).toFixed(2)} ` +
            `(set WALLET_AUTO_REPAIR=true to fix)`
          );
        }
      }
    }

    const summary = {
      ok: true,
      balanceDrift: drift.length,
      heldDrift: heldDrift.length,
      negative: negative.length,
      orphanHolds: orphanHolds.length,
      snapped,
      heldSnapped,
      orphansFixed,
    };

    if (
      drift.length ||
      heldDrift.length ||
      negative.length ||
      orphanHolds.length
    ) {
      console.warn('[reconcile] summary', summary);
    }

    return summary;
  } catch (err) {
    console.error('[reconcile] error:', err.message);
    return { ok: false, error: err.message };
  }
}

export function startWalletReconcileJob() {
  cron.schedule('*/2 * * * *', reconcileWallets, { timezone: 'Africa/Lagos' });
  console.log(
    `[reconcile] wallet health job every 2 min (auto-repair: ${AUTO_REPAIR ? 'ON' : 'OFF'})`
  );
  setTimeout(reconcileWallets, 5_000);
}

export default { reconcileWallets, startWalletReconcileJob };
