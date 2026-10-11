// jobs/airtime-status.job.js
// ============================================================
// Airtime status poller — MONEY-SAFE
//
// RULES (provider is source of truth):
//   1. DataShop SUCCESS/delivered  → releaseHold + Shatova SUCCESS
//   2. DataShop FAILED (explicit)  → dropHold + Shatova FAILED
//   3. DataShop PENDING/processing → Shatova stays PROCESSING
//      (NO time-based fail while provider still says pending)
//   4. Not found on DataShop:
//        age < 6 hours  → wait (tx may still appear)
//        age >= 6 hours → FAILED + refund (safe assumption)
//   5. Provider unreachable (network errors):
//        leave PROCESSING — never invent FAILED
//
// This prevents: refund on Shatova → later delivery on DataShop
//                → free product + merchant loss
// ============================================================
import { query } from '../config/database.js';
import { checkAirtimeStatus, normalizeProviderStatus } from '../services/datashop.service.js';
import { releaseHold, dropHold } from '../services/wallet.service.js';
import { buildRemark } from '../utils/remark.js';

const INTERVAL_MS         = 60 * 1000;
const GRACE_AFTER_SECS    = 90;           // first poll after 90s
const RECHECK_AFTER_SECS  = 60;           // min gap between polls
const BATCH_SIZE          = 30;
const MAX_TX_AGE_HOURS    = 48;           // stop polling after 48h
const NOT_FOUND_FAIL_SECS = 6 * 60 * 60;  // 6 hours — only then treat not-found as failed

let timer = null;
let running = false;

function ageSecs(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 1000;
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

/**
 * Interpret provider payload.
 * PENDING is checked first so we never false-success or false-fail.
 */
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
  // Strict success only
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
  // Ambiguous → processing (keep money on hold)
  return 'processing';
}

async function probe(tx) {
  const refs = [...new Set([tx.provider_reference, tx.reference].filter(Boolean))];
  let sawNotFound = false;
  let lastErr = null;

  for (const ref of refs) {
    try {
      const check = await checkAirtimeStatus(ref);
      const kind = interpret(check);
      return { kind, check, ref, error: null };
    } catch (err) {
      lastErr = err;
      if (isNotFoundError(err)) {
        sawNotFound = true;
        continue; // try other ref
      }
      // Network / 5xx → do NOT fail the tx
      console.warn(`[airtime-status] ${tx.reference} probe ${ref}: ${err.message}`);
    }
  }

  if (sawNotFound) {
    return {
      kind: 'not_found',
      check: null,
      ref: tx.reference,
      error: lastErr?.message || 'not found',
    };
  }

  // Unreachable / unknown → treat as still processing (safe)
  return {
    kind: 'processing',
    check: null,
    ref: tx.reference,
    error: lastErr?.message || 'unreachable',
  };
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
    [
      check?.data?.reference || null,
      JSON.stringify({ status_check: check }),
      remark,
      tx.id,
    ]
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
    [
      JSON.stringify({ status_check: check, reason }),
      remark,
      tx.id,
    ]
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

        console.log(
          `[airtime-status] ${tx.reference} age=${Math.round(age)}s → ${result.kind}` +
          (result.error ? ` (${result.error})` : '')
        );

        // ── Explicit SUCCESS ────────────────────────────────
        if (result.kind === 'successful') {
          await markSuccess(tx, result.check);
          continue;
        }

        // ── Explicit FAILED ─────────────────────────────────
        if (result.kind === 'failed') {
          await markFailed(
            tx,
            result.error || result.check?.message || 'Provider failed',
            result.check
          );
          continue;
        }

        // ── NOT FOUND ───────────────────────────────────────
        // Only fail after 6 hours. Early not-found is common while
        // DataShop is still ingesting the purchase.
        if (result.kind === 'not_found') {
          if (age >= NOT_FOUND_FAIL_SECS) {
            await markFailed(
              tx,
              `Not found on DataShop after ${Math.round(NOT_FOUND_FAIL_SECS / 3600)}h — auto-refunded`,
              null
            );
          } else {
            console.log(
              `[airtime-status] ${tx.reference} not found — wait ` +
              `(age ${Math.round(age / 60)}m / fail after ${Math.round(NOT_FOUND_FAIL_SECS / 3600)}h)`
            );
          }
          continue;
        }

        // ── PENDING / PROCESSING / UNREACHABLE ──────────────
        // DO NOT fail. Money stays on hold until provider settles.
        console.log(
          `[airtime-status] ${tx.reference} still pending/unknown on DataShop — leave PROCESSING`
        );
      } catch (err) {
        // Never turn random errors into FAILED
        if (isNotFoundError(err) && ageSecs(tx.created_at) >= NOT_FOUND_FAIL_SECS) {
          try {
            await markFailed(tx, 'Not found on DataShop — auto-refunded', null);
          } catch (e2) {
            console.error(`[airtime-status] markFailed ${tx.reference}:`, e2.message);
          }
        } else {
          console.warn(`[airtime-status] ${tx.reference} check error:`, err.message);
        }
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
  console.log(
    '[airtime-status] MONEY-SAFE mode | pending→stay PROCESSING | ' +
    'not-found fail after 6h | no time-fail while pending'
  );
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
