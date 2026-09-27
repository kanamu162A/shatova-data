// controllers/webhook.controller.js
// ============================================================
// DataShop Webhook Handler
//   ⭐ SHA256 signature via datashop.verifyWebhookSignature
//   ⭐ Idempotent — status guard on transactions.status
//   ⭐ Moves money via wallet.service (releaseHold / dropHold)
//   ⭐ Responds 200 immediately, processes async
// ============================================================

import { query } from '../config/database.js';
import * as wallet   from '../services/wallet.service.js';
import * as datashop from '../services/datashop.service.js';
import { env } from '../env/env.js';

const SECRET = env.DATASHOP_WEBHOOK_SECRET || process.env.DATASHOP_WEBHOOK_SECRET || '';

function normalizeRemoteStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['successful','success','completed','approved','paid','delivered','done'].some(x => s.includes(x))) return 'success';
  if (['failed','failure','rejected','cancelled','canceled','error','refunded','reversed','invalid'].some(x => s.includes(x))) return 'failed';
  return 'processing';
}

async function finalizeFromWebhook(reference, newStatus, remark, meta = {}) {
  const { rows } = await query(
    `SELECT id, user_id, reference, amount, status, metadata, description
       FROM transactions
      WHERE reference = $1
      LIMIT 1`,
    [reference]
  );
  const tx = rows[0];
  if (!tx) {
    console.warn(`[webhook] unknown ref ${reference}`);
    return { ok: false, reason: 'not_found' };
  }

  const current = String(tx.status || '').toUpperCase();
  if (['SUCCESS', 'FAILED'].includes(current)) {
    console.log(`[webhook] ${reference} already ${current} — ignoring`);
    return { ok: true, reason: 'already_final', status: current };
  }

  const txMeta = tx.metadata || {};
  const safeRemark = remark || (newStatus === 'success' ? 'Delivered' : 'Failed');
  const nowIso = new Date().toISOString();

  if (newStatus === 'success') {
    try {
      await wallet.releaseHold({
        userId: tx.user_id,
        reference,
        transactionId: tx.id,
        description: `Data purchase — ${txMeta.product_name || ''}`,
      });
      console.log(`[webhook] 🔓 released hold for ${reference}`);
    } catch (err) {
      console.warn(`[webhook] releaseHold failed for ${reference}:`, err.message);
    }

    await query(
      `UPDATE transactions
          SET status = 'SUCCESS',
              description = $1,
              remark = $1,
              metadata = metadata || $2::jsonb,
              updated_at = NOW()
        WHERE reference = $3`,
      [
        safeRemark,
        JSON.stringify({
          webhook_received_at: nowIso,
          webhook_status: 'success',
          finalized_by: 'webhook',
          reconcile_next_at: null,
          ds_reference: meta.reference || txMeta.ds_reference || reference,
          ds_paid_amount: Number(meta.paidAmount || 0),
          ds_status: meta.status || 'success',
        }),
        reference,
      ]
    );

    return { ok: true, status: 'SUCCESS' };
  }

  try {
    await wallet.dropHold({ userId: tx.user_id, reference });
    console.log(`[webhook] 🔙 dropped hold for ${reference}`);
  } catch (err) {
    console.warn(`[webhook] dropHold failed for ${reference}:`, err.message);
  }

  await query(
    `UPDATE transactions
        SET status = 'FAILED',
            description = $1,
            remark = $1,
            metadata = metadata || $2::jsonb,
            updated_at = NOW()
      WHERE reference = $3`,
    [
      safeRemark,
      JSON.stringify({
        webhook_received_at: nowIso,
        webhook_status: 'failed',
        finalized_by: 'webhook',
        reconcile_next_at: null,
        ds_reference: meta.reference || txMeta.ds_reference || reference,
        ds_status: meta.status || 'failed',
      }),
      reference,
    ]
  );

  return { ok: true, status: 'FAILED' };
}

export async function datashopWebhook(req, res) {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  const signature =
    req.headers['x-datashop-signature'] ||
    req.headers['x-webhook-signature'] ||
    req.headers['x-signature'] ||
    req.headers['x-datashop-hmac'];

  if (SECRET) {
    const ok = datashop.verifyWebhookSignature(rawBody, signature, SECRET);
    if (!ok) {
      console.warn('[webhook] ❌ invalid signature');
      return res.status(401).json({ success: false, message: 'invalid signature' });
    }
  } else {
    console.warn('[webhook] ⚠ no secret configured — signature check skipped');
  }

  const body = req.body || {};
  console.log('[webhook] ← datashop event:', body.event || body.type || 'unknown');
  console.log('[webhook] payload:', JSON.stringify(body).slice(0, 800));

  res.status(200).json({ success: true, received: true });

  let payload;
  try {
    payload = datashop.normalizeWebhookPayload(body);
  } catch (err) {
    console.warn('[webhook] normalizeWebhookPayload failed:', err.message);
    return;
  }

  const { reference, status: rawStatus, remark: rawRemark, event } = payload;

  query(
    `INSERT INTO webhook_events
       (reference, event_type, remote_status, payload, signature_ok, received_at)
     VALUES ($1, $2, $3, $4, true, NOW())`,
    [reference || null, event, rawStatus || null, JSON.stringify(body)]
  ).catch((err) => console.warn('[webhook] audit insert failed:', err.message));

  if (!reference) {
    console.warn('[webhook] no reference in payload');
    return;
  }

  const normalized = normalizeRemoteStatus(rawStatus);
  if (normalized === 'processing') {
    console.log(`[webhook] ${reference} still processing (${rawStatus}) — waiting`);
    return;
  }

  try {
    const finalRemark = rawRemark || `DataShop: ${rawStatus}`;
    const result = await finalizeFromWebhook(reference, normalized, finalRemark, payload);
    console.log(`[webhook] ✅ ${reference} → ${result.status || result.reason}`);
  } catch (err) {
    console.error(`[webhook] processing error for ${reference}:`, err.message);
  }
}

export async function datashopWebhookHealth(req, res) {
  let dbOk = true;
  try { await query('SELECT 1'); } catch { dbOk = false; }
  res.json({
    success: true,
    service: 'Shatova Webhooks',
    target: 'datashop',
    status: 'listening',
    db: dbOk ? 'ok' : 'down',
    hasSecret: Boolean(SECRET),
    ts: new Date().toISOString(),
  });
}

export default { datashopWebhook, datashopWebhookHealth };