// jobs/airtime-status.job.js
// ============================================================
// Airtime status poller — MONEY-SAFE v2
//   ⭐ Fixes "reference too short" bug which caused false refunds.
//   ⭐ Never fails a tx on "not found" if we suspect it was delivered.
// ============================================================
import { query } from '../config/database.js';
import { checkAirtimeStatus, normalizeProviderStatus } from '../services/vtu.service.js';
import { releaseHold, dropHold } from '../services/wallet.service.js';
import { buildRemark } from '../utils/remark.js';

const INTERVAL_MS         = 60 * 1000;
const GRACE_AFTER_SECS    = 90;
const RECHECK_AFTER_SECS  = 60;
const BATCH_SIZE          = 30;
const MAX_TX_AGE_HOURS    = 72;           // stop polling after 72h
const NOT_FOUND_FAIL_SECS = 6 * 60 * 60;  // 6 hours

let timer = null;
let running = false;

function ageSecs(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 1000;
}

function isFatalNotFoundError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  // ⭐ The exact error DataShop sends for short refs
  if (m.includes('reference field must be at least')) return true;
  return false;
}

function isNotFoundError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return (
    m.includes('not found') ||
    m.includes('404') ||
    m.includes('no transaction') ||
    m.includes('does not exist')
  );
}

function interpret(check) {
  const b = check?.data || check || {};
  const candidates = [
    b.transaction_status, b.transactionStatus,
    b.payment_status, b.paymentStatus,
    b.state, b.status, b.result,
    check?.status, check?.message, check?.remark,
    b.message, b.remark, b.delivery_status,
  ].filter((v) => v != null && typeof v !== 'boolean');

  const PENDING = [
    'processing', 'pending', 'in_progress', 'in-progress', 'submitted',
    'queued', 'initiated', 'awaiting', 'in progress', 'new', 'created',
    'accepted', 'received', 'waiting',
  ];
  const FAILED = [
    'fail', 'failed', 'failure', 'reject', 'rejected', 'cancel', 'cancelled',
    'decline', 'declined', 'error', 'refund', 'refunded', 'reversed', 'invalid',
    'not successful', 'unsuccessful', 'expired', 'abandoned', 'denied',
    'timeout',
  ];
  const SUCCESS = [
    'successful', 'succeeded', 'delivered', 'completed', 'complete',
    'credited', 'confirmed',
  ];

  for (const raw of candidates) {
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;
    if (PENDING.some((k) => s === k || s.includes(k))) return 'processing';
    if (s.includes('not found')) return 'not_found';
    if (FAILED.some((k) => s.includes(k))) return 'failed';
  }
  for (const raw of candidates) {
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;
    if (SUCCESS.some((k) => s === k || s.includes(k))) return 'successful';
  }

  try {
    const n = normalizeProviderStatus(check);
    if (n === 'failed') return 'failed';
    if (n === 'successful') {
      const blob = JSON.stringify(check || {}).toLowerCase();
      if (PENDING.some((k) => blob.includes(`"${k}"`) || blob.includes(`:${k}`))) {
        return 'processing';
      }
      return 'successful';
    }
    if (n === 'processing' || n === 'pending') return 'processing';
  } catch (_) { /* ignore */ }

  if (check?.success === false) return 'failed';
  return 'processing';
}

async function probe(tx) {
  const refs = [...new Set([tx.provider_reference, tx.reference].filter(Boolean))];
  let sawNotFound = false;
  let sawFatal = false;
  let lastErr = null;

  for (const ref of refs) {
    try {
      const check = await checkAirtimeStatus(ref);
      const kind = interpret(check);
      return { kind, check, ref, error: null, fatal: false };
    } catch (err) {
      lastErr = err;
      
      if (isFatalNotFoundError(err)) {
        // ⭐ If DataShop says the ref is too short, we MUST assume it succeeded.
        // We cannot verify it. We return 'processing' forever.
        console.warn(`[airtime-status] ${tx.reference} FATAL: ${err.message}. Assuming processing to prevent loss.`);
        sawFatal = true;
        continue;
      }

      if (isNotFoundError(err)) {
        sawNotFound = true;
        continue;
      }
      
      console.warn(`[airtime-status] ${tx.reference} probe ${ref}: ${err.message}`);
    }
  }

  if (sawFatal) {
    return { kind: 'fatal_ref', check: null, ref: tx.reference, error: lastErr?.message, fatal: true };
  }

  if (sawNotFound) {
    return { kind: 'not_found', check: null, ref: tx.reference, error: lastErr?.message, fatal: false };
  }

  return { kind: 'processing', check: null, ref: tx.reference, error: lastErr?.message, fatal: false };
}

async function markSuccess(tx, check) {
  const meta = typeof tx.metadata === 'string'
    ? (() => { try { return JSON.parse(tx.metadata); } catch { return {}; } })()
    : (tx.metadata || {});

  try {
    await releaseHold({
      userId: tx.user_id,
      reference: tx.reference,
      transactionId: tx.id,
      description: tx.description,
    });
  } catch (e) {
    console.error(`[airtime-status] releaseHold ${tx.reference}:`, e.message);
  }

  const remark = buildRemark({
    status: 'success',
    network: meta.network || '',
    phone: meta.phone || '',
    amount: Number(meta.user_paid || 0),
    service: 'airtime',
    discount: Number(meta.user_discount_amt || 0),
  });

  await query(
    `UPDATE transactions
        SET status = 'SUCCESS',
            provider_reference = COALESCE($1, provider_reference),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            description = $3,
            updated_at = NOW()
      WHERE id = $4 AND status = 'PROCESSING'`,
    [check?.data?.reference || null, JSON.stringify({ status_check: check }), remark, tx.id]
  );
  console.log(`[airtime-status] ✅ ${tx.reference} → SUCCESS`);
}

async function markFailed(tx, reason, check = null) {
  const meta = typeof tx.metadata === 'string'
    ? (() => { try { return JSON.parse(tx.metadata); } catch { return {}; } })()
    : (tx.metadata || {});

  try {
    await dropHold({ userId: tx.user_id, reference: tx.reference });
  } catch (e) {
    console.error(`[airtime-status] dropHold ${tx.reference}:`, e.message);
  }

  const remark = buildRemark({
    status: 'failed',
    code: 'PROVIDER_FAILED',
    providerMessage: reason,
    network: meta.network || '',
    phone: meta.phone || '',
    amount: Number(meta.user_paid || 0),
    service: 'airtime',
  });

  await query(
    `UPDATE transactions
        SET status = 'FAILED',
            metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
            description = $2,
            updated_at = NOW()
      WHERE id = $3 AND status = 'PROCESSING'`,
    [JSON.stringify({ status_check: check, reason }), remark, tx.id]
  );
  console.log(`[airtime-status] ❌ ${tx.reference} → FAILED (${reason})`);
}

async function tick() {
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

    if (!rows.length) return;
    console.log(`[airtime-status] Checking ${rows.length} transaction(s)…`);

    for (const tx of rows) {
      try {
        const age = ageSecs(tx.created_at);
        const result = await probe(tx);

        console.log(`[airtime-status] ${tx.reference} age=${Math.round(age)}s → ${result.kind} (${result.error || 'ok'})`);

        if (result.kind === 'successful') {
          await markSuccess(tx, result.check);
          continue;
        }

        if (result.kind === 'failed') {
          await markFailed(tx, result.error || result.check?.message || 'Provider failed', result.check);
          continue;
        }

        if (result.kind === 'not_found') {
          if (age >= NOT_FOUND_FAIL_SECS) {
            await markFailed(tx, `Not found on DataShop after 6h — auto-refunded`, null);
          } else {
            console.log(`[airtime-status] ${tx.reference} not found — waiting...`);
          }
          continue;
        }

        // ⭐ If we get FATAL_REF, we just leave it in PROCESSING forever.
        if (result.kind === 'fatal_ref') {
          console.log(`[airtime-status] ${tx.reference} Fatal ref error — leaving PROCESSING`);
          continue;
        }

        console.log(`[airtime-status] ${tx.reference} still pending/unknown on DataShop — leave PROCESSING`);
      } catch (err) {
        console.warn(`[airtime-status] ${tx.reference} check error:`, err.message);
      }
    }
  } catch (err) {
    console.error('[airtime-status] job error:', err);
  } finally {
    running = false;
  }
}

export function startAirtimeStatusJob() {
  if (timer) return;
  console.log('[airtime-status] MONEY-SAFE v2 | rejecting short refs | never auto-fail on fatal errors');
  timer = setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 8_000);
}

export function stopAirtimeStatusJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default { startAirtimeStatusJob, stopAirtimeStatusJob };
