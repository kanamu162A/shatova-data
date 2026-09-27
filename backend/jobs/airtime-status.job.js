// jobs/airtime-status.job.js
// ============================================================

import { query } from '../config/database.js';
import { checkAirtimeStatus, normalizeProviderStatus } from '../services/datashop.service.js';
import { releaseHold, dropHold } from '../services/wallet.service.js';
import { buildRemark } from '../utils/remark.js';

const INTERVAL_MS        = 60 * 1000;
const GRACE_AFTER_SECS   = 120;
const RECHECK_AFTER_SECS = 120;
const BATCH_SIZE         = 10;
const MAX_TX_AGE_HOURS   = 24;

let timer = null;
let running = false;

export function startAirtimeStatusJob() {
  if (timer) return;
  console.log('[airtime-status] Job started — polling every 60s');

  timer = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      const { rows } = await query(
        `SELECT id, user_id, reference, status, metadata, description,
                provider_reference, updated_at, created_at
           FROM transactions
          WHERE status = 'PROCESSING'
            AND type = 'VTU' AND service = 'AIRTIME'
            AND created_at < NOW() - ($1 || ' seconds')::interval
            AND updated_at < NOW() - ($2 || ' seconds')::interval
            AND created_at > NOW() - ($3 || ' hours')::interval
          ORDER BY updated_at ASC
          LIMIT $4`,
        [GRACE_AFTER_SECS, RECHECK_AFTER_SECS, MAX_TX_AGE_HOURS, BATCH_SIZE]
      );

      if (!rows.length) { running = false; return; }
      console.log(`[airtime-status] Checking ${rows.length} transaction(s)…`);

      for (const tx of rows) {
        try {
          const check = await checkAirtimeStatus(tx.reference);
          const providerStatus = normalizeProviderStatus(check);

          const meta = tx.metadata || {};
          const networkKey = meta.network || '';
          const phone = meta.phone || '';
          const amount = Number(meta.user_paid || 0);

          if (providerStatus === 'successful') {
            await releaseHold({
              userId: tx.user_id, reference: tx.reference,
              transactionId: tx.id, description: tx.description,
            });

            const remark = buildRemark({
              status: 'success', network: networkKey, phone, amount,
              service: 'airtime', discount: Number(meta.user_discount_amt || 0),
            });

            await query(
              `UPDATE transactions
                  SET status = 'SUCCESS',
                      provider_reference = COALESCE($1, provider_reference),
                      metadata = metadata || $2::jsonb, description = $3,
                      updated_at = NOW()
                WHERE id = $4`,
              [check?.data?.reference || null, JSON.stringify({ status_check: check }), remark, tx.id]
            );
            console.log(`[airtime-status] ✅ ${tx.reference} → SUCCESS`);

          } else if (providerStatus === 'failed') {
            await dropHold({ userId: tx.user_id, reference: tx.reference });
            const remark = buildRemark({
              status: 'failed', code: 'PROVIDER_FAILED',
              providerMessage: check?.message,
              network: networkKey, phone, amount, service: 'airtime',
            });
            await query(
              `UPDATE transactions
                  SET status = 'FAILED', metadata = metadata || $1::jsonb,
                      description = $2, updated_at = NOW()
                WHERE id = $3`,
              [JSON.stringify({ status_check: check, reason: check?.message }), remark, tx.id]
            );
            console.log(`[airtime-status] ❌ ${tx.reference} → FAILED (hold dropped)`);
          }
        } catch (err) {
          console.warn(`[airtime-status] ${tx.reference} check failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[airtime-status] job error:', err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}

export function stopAirtimeStatusJob() {
  if (timer) { clearInterval(timer); timer = null; }
}