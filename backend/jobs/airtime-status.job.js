// jobs/airtime-status.job.js
// ============================================================
// Poll PROCESSING airtime txs against DataShop.
// Provider is source of truth.
//
// FIX: "Transaction not found on DataShop" is NO longer ignored.
//   After GRACE → dropHold + FAILED.
// ============================================================
import { query } from '../config/database.js';
import { checkAirtimeStatus, normalizeProviderStatus } from '../services/datashop.service.js';
import { releaseHold, dropHold } from '../services/wallet.service.js';
import { buildRemark } from '../utils/remark.js';

const INTERVAL_MS        = 60 * 1000;
const GRACE_AFTER_SECS   = 90;    // wait 90s before first poll
const RECHECK_AFTER_SECS = 60;    // min gap between polls of same tx
const BATCH_SIZE         = 20;
const MAX_TX_AGE_HOURS   = 24;
const NOT_FOUND_FAIL_SECS = 120;  // not found → fail after 2 min age
const HARD_FAIL_SECS      = 30 * 60; // 30 min absolute

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

/** Conservative status — never treat vague payloads as success */
function interpret(check) {
  const b = check?.data || check || {};
  const candidates = [
    b.transaction_status, b.transactionStatus,
    b.payment_status, b.paymentStatus,
    b.state, b.status, b.result,
    check?.status, check?.message, check?.remark,
    b.message, b.remark,
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
    'timeout', 'not found',
  ];
  const SUCCESS = [
    'successful', 'succeeded', 'delivered', 'completed', 'complete',
    'credited', 'confirmed',
  ];

  for (const raw of candidates) {
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;
    if (PENDING.some((k) => s === k || s.includes(k))) return 'processing';
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
      if (PENDING.some((k) => blob.includes(k))) return 'processing';
      return 'successful';
    }
  } catch (_) { /* ignore */ }

  if (check?.success === false) return 'failed';
  return 'processing';
}

async function probe(tx) {
  const refs = [...new Set([tx.provider_reference, tx.reference].filter(Boolean))];
  let lastNotFound = null;
  let lastErr = null;

  for (const ref of refs) {
    try {
      const check = await checkAirtimeStatus(ref);
      return { kind: interpret(check), check, ref, error: null };
    } catch (err) {
      lastErr = err;
      if (isNotFoundError(err)) {
        lastNotFound = err;
        continue; // try next ref
      }
      console.warn(`[airtime-status] ${tx.reference} probe ${ref}:`, err.message);
    }
  }

  if (lastNotFound) {
    return { kind: 'not_found', check: null, ref: tx.reference, error: lastNotFound.message };
  }
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
            await markFailed(
              tx,
              `Not found on DataShop after ${Math.round(NOT_FOUND_FAIL_SECS / 60)}m — auto-refunded`,
              null
            );
          } else {
            console.log(
              `[airtime-status] ${tx.reference} not found — waiting until ${NOT_FOUND_FAIL_SECS}s age`
            );
          }
          continue;
        }

        // still processing
        if (age >= HARD_FAIL_SECS) {
          await markFailed(tx, `Hard timeout ${HARD_FAIL_SECS / 60}m — auto-refunded`, null);
        }
      } catch (err) {
        // Last resort: not-found style errors must not be swallowed
        if (isNotFoundError(err) && ageSecs(tx.created_at) >= NOT_FOUND_FAIL_SECS) {
          try {
            await markFailed(tx, `Not found on DataShop — auto-refunded`, null);
          } catch (e2) {
            console.error(`[airtime-status] markFailed failed ${tx.reference}:`, e2.message);
          }
        } else {
          console.warn(`[airtime-status] ${tx.reference} check failed:`, err.message);
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
    '[airtime-status] Job started — every 60s | not-found→FAIL after 2m | hard-fail 30m'
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
