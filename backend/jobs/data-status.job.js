// jobs/data-status.job.js
// ============================================================
// Shatova — Data Status Job (hold/release/drop)
//   ⭐ Same pattern as airtime-status.job.js
// ============================================================

import { query } from '../config/database.js';
import { checkTransactionStatus, normalizeProviderStatus } from '../services/datashop.service.js';
import { releaseHold, dropHold } from '../services/wallet.service.js';

const INTERVAL_MS        = 60 * 1000;
const GRACE_AFTER_SECS   = 60;
const RECHECK_AFTER_SECS = 45;
const BATCH_SIZE         = 15;
const MAX_TX_AGE_HOURS   = 24;

let timer = null;
let running = false;

export function startDataStatusJob() {
  if (timer) return;
  console.log('[data-status] Job started — every 60s');

  timer = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      const { rows } = await query(
        `SELECT id, user_id, reference, status, metadata, description,
                remark, cost_price, profit, created_at, updated_at
           FROM transactions
          WHERE status IN ('PENDING', 'PROCESSING')
            AND type = 'DATA'
            AND created_at < NOW() - ($1 || ' seconds')::interval
            AND updated_at < NOW() - ($2 || ' seconds')::interval
            AND created_at > NOW() - ($3 || ' hours')::interval
          ORDER BY updated_at ASC
          LIMIT $4`,
        [GRACE_AFTER_SECS, RECHECK_AFTER_SECS, MAX_TX_AGE_HOURS, BATCH_SIZE]
      );

      if (!rows.length) { running = false; return; }
      console.log(`[data-status] Checking ${rows.length} transaction(s)…`);

      for (const tx of rows) {
        try {
          const check = await checkTransactionStatus(tx.reference);
          const providerStatus = normalizeProviderStatus(check);

          const meta = tx.metadata || {};
          const amount = Number(meta.user_price || meta.base_price || tx.amount || 0);
          const dsPayload = check?.data || check || {};
          const dsRemark = dsPayload.remark || check?.message || '';
          const dsCost = Number(dsPayload.paid_amount || tx.cost_price || 0);
          const dsProfit = Math.round((amount - dsCost) * 100) / 100;

          /* SUCCESS → release hold */
          if (providerStatus === 'successful') {
            try {
              await releaseHold({
                userId: tx.user_id,
                reference: tx.reference,
                transactionId: tx.id,
                description: tx.description,
              });
            } catch (err) {
              console.warn(`[data-status] releaseHold: ${err.message}`);
            }

            await query(
              `UPDATE transactions
                  SET status = 'SUCCESS',
                      description = COALESCE($1, description),
                      remark = COALESCE($2, remark),
                      provider_reference = COALESCE($3, provider_reference),
                      cost_price = COALESCE($4, cost_price),
                      profit = COALESCE($5, profit),
                      metadata = metadata || $6::jsonb,
                      updated_at = NOW()
                WHERE id = $7`,
              [
                dsRemark || 'Purchase successful',
                dsRemark || null,
                dsPayload.reference || null,
                dsCost, dsProfit,
                JSON.stringify({
                  ds_status: 'successful',
                  ds_quantity: dsPayload.quantity || '',
                  ds_balance_before: Number(dsPayload.balance_before ?? 0),
                  ds_balance_after:  Number(dsPayload.balance_after  ?? 0),
                }),
                tx.id,
              ]
            );
            console.log(`[data-status] ✅ ${tx.reference} → SUCCESS`);
          }

          /* FAILED → drop hold */
          else if (providerStatus === 'failed') {
            try {
              await dropHold({ userId: tx.user_id, reference: tx.reference });
            } catch (err) {
              console.warn(`[data-status] dropHold: ${err.message}`);
            }

            await query(
              `UPDATE transactions
                  SET status = 'FAILED',
                      description = COALESCE($1, description),
                      remark = COALESCE($2, remark),
                      cost_price = COALESCE($3, cost_price),
                      profit = COALESCE($4, profit),
                      metadata = metadata || $5::jsonb,
                      updated_at = NOW()
                WHERE id = $6`,
              [
                dsRemark || 'Purchase failed',
                dsRemark || null,
                dsCost, dsProfit,
                JSON.stringify({ ds_status: 'failed' }),
                tx.id,
              ]
            );
            console.log(`[data-status] ❌ ${tx.reference} → FAILED (hold dropped)`);
          }

          /* STILL PROCESSING */
          else {
            await query(
              `UPDATE transactions
                  SET status = CASE WHEN status = 'PENDING' THEN 'PROCESSING' ELSE status END,
                      cost_price = COALESCE(cost_price, $1),
                      profit = COALESCE(profit, $2),
                      metadata = metadata || $3::jsonb,
                      updated_at = NOW()
                WHERE id = $4`,
              [
                dsCost || null,
                dsProfit || null,
                JSON.stringify({ last_check: new Date().toISOString() }),
                tx.id,
              ]
            );
          }
        } catch (err) {
          console.warn(`[data-status] ${tx.reference}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[data-status] job error:', err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}

export function stopDataStatusJob() {
  if (timer) { clearInterval(timer); timer = null; }
}