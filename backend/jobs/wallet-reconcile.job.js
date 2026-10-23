// jobs/wallet-reconcile.job.js
// ============================================================
// Wallet health job — egress-friendly (every 10 min, limited scans)
// ============================================================
import cron from 'node-cron';
import { query } from '../config/database.js';

const AUTO_REPAIR = process.env.WALLET_AUTO_REPAIR === 'true';

export async function reconcileWallets() {
  try {
    // ── 1) Spendable balance drift (capped) ───────────────────
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
      ORDER BY ABS(w.balance - COALESCE(ll.balance_after, 0)) DESC
      LIMIT 100
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
    const { rows: heldDrift } = await query(`
      SELECT
        w.id AS wallet_id,
        w.user_id,
        COALESCE(w.held_balance, 0) AS wallet_held,
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
      ORDER BY ABS(COALESCE(w.held_balance, 0) - COALESCE(h.open_held, 0)) DESC
      LIMIT 100
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

    // ── 3) Negative balances ──────────────────────────────────
    const { rows: negative } = await query(
      `SELECT id, user_id, balance, held_balance
         FROM wallets
        WHERE balance < 0 OR COALESCE(held_balance, 0) < 0
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

    // ── 4) Orphan HELD holds (tx already final) ───────────────
    const { rows: orphanHolds } = await query(`
      SELECT h.id AS hold_id,
             h.wallet_id,
             h.user_id,
             h.reference,
             h.amount,
             t.status AS tx_status,
             t.id AS transaction_id
        FROM wallet_holds h
        JOIN transactions t
          ON t.reference = h.reference
         AND t.user_id = h.user_id
       WHERE h.status = 'HELD'
         AND UPPER(t.status) IN ('SUCCESS', 'FAILED', 'REFUNDED')
       ORDER BY h.created_at ASC
       LIMIT 50
    `);

    let orphansFixed = 0;
    if (orphanHolds.length) {
      for (const h of orphanHolds) {
        const txSt = String(h.tx_status || '').toUpperCase();
        const newHoldStatus = txSt === 'SUCCESS' ? 'RELEASED' : 'DROPPED';
        if (AUTO_REPAIR) {
          await query(
            `UPDATE wallet_holds
                SET status = $1, resolved_at = NOW()
              WHERE id = $2 AND status = 'HELD'`,
            [newHoldStatus, h.hold_id]
          );
          if (txSt === 'FAILED' || txSt === 'REFUNDED') {
            await query(
              `UPDATE wallets
                  SET balance = balance + $1,
                      held_balance = GREATEST(COALESCE(held_balance, 0) - $1, 0),
                      version = version + 1,
                      updated_at = NOW()
                WHERE id = $2`,
              [Number(h.amount), h.wallet_id]
            );
            await query(
              `INSERT INTO wallet_ledger
                 (wallet_id, user_id, transaction_id, reference, type, direction,
                  amount, balance_before, balance_after, description,
                  status, metadata, created_at, updated_at)
               SELECT w.id, w.user_id, $1, $2, 'HOLD_RELEASE', 'CREDIT',
                      $3, w.balance - $3, w.balance,
                      'Auto-repair: orphan hold after tx ' || $4,
                      'successful', '{}'::jsonb, NOW(), NOW()
                 FROM wallets w WHERE w.id = $5`,
              [h.transaction_id, h.reference, Number(h.amount), txSt, h.wallet_id]
            );
          } else {
            await query(
              `UPDATE wallets
                  SET held_balance = GREATEST(COALESCE(held_balance, 0) - $1, 0),
                      version = version + 1,
                      updated_at = NOW()
                WHERE id = $2`,
              [Number(h.amount), h.wallet_id]
            );
          }
          orphansFixed++;
          console.warn(
            `[reconcile] ORPHAN hold fixed hold=${h.hold_id} ref=${h.reference} ` +
            `${txSt} → hold=${newHoldStatus}`
          );
        } else {
          console.warn(
            `[reconcile] ORPHAN hold hold=${h.hold_id} wallet=${h.wallet_id} ` +
            `ref=${h.reference} status=${txSt} amount=₦${Number(h.amount).toFixed(2)} ` +
            `(set WALLET_AUTO_REPAIR=true to fix)`
          );
        }
      }
    }

    // ── 5) Stuck PROCESSING + open hold > 10m ─────────────────
    const { rows: stuck } = await query(`
      SELECT t.id, t.user_id, t.reference, t.status, t.created_at,
             h.id AS hold_id, h.amount AS hold_amount
        FROM transactions t
        JOIN wallet_holds h
          ON h.reference = t.reference
         AND h.user_id = t.user_id
         AND h.status = 'HELD'
       WHERE UPPER(t.status) IN ('PROCESSING', 'PENDING')
         AND t.created_at < NOW() - INTERVAL '10 minutes'
       ORDER BY t.created_at ASC
       LIMIT 50
    `);

    let stuckFailed = 0;
    if (stuck.length) {
      for (const s of stuck) {
        try {
          await query(
            `UPDATE wallets
                SET balance = balance + $1,
                    held_balance = GREATEST(COALESCE(held_balance, 0) - $1, 0),
                    version = version + 1,
                    updated_at = NOW()
              WHERE user_id = $2`,
            [Number(s.hold_amount), s.user_id]
          );
          await query(
            `UPDATE wallet_holds
                SET status = 'DROPPED', resolved_at = NOW()
              WHERE id = $1 AND status = 'HELD'`,
            [s.hold_id]
          );
          await query(
            `INSERT INTO wallet_ledger
               (wallet_id, user_id, transaction_id, reference, type, direction,
                amount, balance_before, balance_after, description,
                status, metadata, created_at, updated_at)
             SELECT w.id, w.user_id, $1, $2, 'HOLD_RELEASE', 'CREDIT',
                    $3, w.balance - $3, w.balance,
                    'Auto-fail: stuck PROCESSING >10m — refunded',
                    'successful', '{}'::jsonb, NOW(), NOW()
               FROM wallets w WHERE w.user_id = $4
             LIMIT 1`,
            [s.id, s.reference, Number(s.hold_amount), s.user_id]
          );
          await query(
            `UPDATE transactions
                SET status = 'FAILED',
                    description = 'Auto-fail: stuck >10m (not confirmed on DataShop) — refunded',
                    updated_at = NOW()
              WHERE id = $1 AND UPPER(status) IN ('PROCESSING','PENDING')`,
            [s.id]
          );
          stuckFailed++;
          console.warn(`[reconcile] STUCK auto-fail REFUND ref=${s.reference} ₦${Number(s.hold_amount).toFixed(2)}`);
        } catch (err) {
          console.error(`[reconcile] STUCK fail error ref=${s.reference}:`, err.message);
        }
      }
    }

    const summary = {
      ok: true,
      balanceDrift: drift.length,
      heldDrift: heldDrift.length,
      negative: negative.length,
      orphanHolds: orphanHolds.length,
      stuckOpen: stuck.length,
      snapped,
      heldSnapped,
      orphansFixed,
      stuckFailed,
    };

    if (
      drift.length ||
      heldDrift.length ||
      negative.length ||
      orphanHolds.length ||
      stuck.length
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
  // Was every 2 min → now every 10 min (free-tier friendly)
  cron.schedule('*/10 * * * *', reconcileWallets, { timezone: 'Africa/Lagos' });
  console.log(
    `[reconcile] wallet health job every 10 min (auto-repair: ${AUTO_REPAIR ? 'ON' : 'OFF'})`
  );
  // First run after 30s (not 5s) so boot is not flooded
  setTimeout(reconcileWallets, 30_000);
}

export default { reconcileWallets, startWalletReconcileJob };
