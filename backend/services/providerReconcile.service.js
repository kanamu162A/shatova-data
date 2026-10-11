// services/reconciler.service.js
// ============================================================
// Shatova — Reconciler (provider is source of truth)
//   • Syncs PENDING + PROCESSING against DataShop
//   • Fail fast when provider says not found / failed
//   • Never invent SUCCESS — only promote when provider confirms
//   • Uses same processWebhook path (idempotent)
// ============================================================
import { query } from '../config/database.js';
import { processWebhook } from '../controllers/webhook.controller.js';
import { env } from '../env/env.js';

const DS_BASE = env.VTU_API_BASE;
const DS_KEY  = env.VTU_API_KEY;
const DS_STATUS_PATH = env.DATASHOP_STATUS_ENDPOINT || '/transaction/status';

// ─── Tunables (aggressive enough to protect customer trust) ──
const AGE_MIN              = 2;    // start checking after 2 minutes
const NOT_FOUND_FAIL_MIN   = 2;    // provider "not found" → fail after 2m
const PENDING_FAIL_MIN     = 12;   // still pending at provider → fail after 12m
const HARD_FAIL_MIN        = 30;   // absolute cap
const BATCH_LIMIT          = 150;
const VERIFY_RECENT_SUCCESS_MIN = 0; // set >0 to re-check recent SUCCESS (optional)

// ─── Fetch provider status ──────────────────────────────────
async function fetchDatashopStatus(reference) {
  if (!DS_BASE || !DS_KEY) {
    throw new Error('VTU_API_BASE / VTU_API_KEY not configured');
  }
  const url = `${DS_BASE}${DS_STATUS_PATH}?reference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${DS_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { httpStatus: res.status, body, raw: text };
}

// ─── Interpret provider response ────────────────────────────
function interpret(resp) {
  const b = resp.body;
  if (resp.httpStatus === 404) return { kind: 'NOT_FOUND', remark: 'HTTP 404' };
  if (!b) return { kind: 'UNKNOWN', remark: `HTTP ${resp.httpStatus}` };

  const candidates = [
    b.transaction_status,
    b.transactionStatus,
    b.payment_status,
    b.paymentStatus,
    b.state,
    b.status,
    b.result,
    b.data?.transaction_status,
    b.data?.transactionStatus,
    b.data?.payment_status,
    b.data?.status,
    b.data?.state,
    b.data?.result,
  ].filter((v) => v != null && typeof v !== 'boolean');

  const FAILED_KEYS = [
    'fail', 'failed', 'failure', 'reject', 'rejected', 'cancel', 'cancelled', 'canceled',
    'decline', 'declined', 'error', 'refund', 'refunded', 'reversed', 'invalid',
    'not successful', 'unsuccessful', 'expired', 'abandoned', 'aborted', 'denied',
    'timeout', 'timed out', 'not found',
  ];
  const SUCCESS_KEYS = [
    'success', 'successful', 'succeeded', 'complete', 'completed', 'delivered',
    'approved', 'done', 'paid', 'processed', 'sent', 'credited', 'confirmed',
  ];
  const PENDING_KEYS = [
    'processing', 'pending', 'in_progress', 'in-progress', 'submitted',
    'queued', 'initiated', 'awaiting', 'in progress', 'new', 'created',
    'accepted', 'received',
  ];

  for (const raw of candidates) {
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;
    if (FAILED_KEYS.some((k) => s.includes(k))) {
      return { kind: 'FAILED', remark: b.message || b.remark || s };
    }
    if (SUCCESS_KEYS.some((k) => s.includes(k))) {
      return { kind: 'SUCCESS', remark: b.message || b.remark || 'Delivered' };
    }
    if (PENDING_KEYS.some((k) => s.includes(k))) {
      return { kind: 'PENDING', remark: b.message || s };
    }
  }

  const msg = String(b.message || b.remark || '').toLowerCase();
  if (msg.includes('not found')) return { kind: 'NOT_FOUND', remark: msg };
  if (FAILED_KEYS.some((k) => msg.includes(k))) {
    return { kind: 'FAILED', remark: b.message || msg };
  }
  if (SUCCESS_KEYS.some((k) => msg.includes(k))) {
    return { kind: 'SUCCESS', remark: b.message || msg };
  }
  if (typeof b.status === 'boolean') {
    return b.status
      ? { kind: 'SUCCESS', remark: 'Boolean status true' }
      : { kind: 'FAILED', remark: 'Boolean status false' };
  }
  if (Array.isArray(b.data) && b.data[0]) {
    return interpret({ httpStatus: resp.httpStatus, body: b.data[0] });
  }
  return { kind: 'PENDING', remark: b.message || 'Unknown state' };
}

/**
 * Apply provider verdict → Shatova status via processWebhook (idempotent).
 * Returns action taken for logging.
 */
async function applyVerdict(tx, verdict, ageMin) {
  if (verdict.kind === 'SUCCESS') {
    await processWebhook(tx.reference, 'SUCCESS', verdict.remark);
    return 'settled';
  }

  if (verdict.kind === 'FAILED') {
    await processWebhook(tx.reference, 'FAILED', verdict.remark || 'Provider failed');
    return 'failed';
  }

  if (verdict.kind === 'NOT_FOUND') {
    if (ageMin >= NOT_FOUND_FAIL_MIN) {
      await processWebhook(
        tx.reference,
        'FAILED',
        `Not found on provider after ${NOT_FOUND_FAIL_MIN}m — auto-refunded`
      );
      return 'failed';
    }
    return 'skipped';
  }

  // PENDING / UNKNOWN — age-based fail to protect wallet + trust
  if (ageMin >= HARD_FAIL_MIN) {
    await processWebhook(
      tx.reference,
      'FAILED',
      `Hard timeout ${HARD_FAIL_MIN}m — auto-refunded`
    );
    return 'gaveUp';
  }
  if (ageMin >= PENDING_FAIL_MIN) {
    await processWebhook(
      tx.reference,
      'FAILED',
      `Provider still pending after ${PENDING_FAIL_MIN}m — auto-refunded`
    );
    return 'gaveUp';
  }
  return 'skipped';
}

// ─── Main reconciler ────────────────────────────────────────
export async function runReconciler() {
  const cutoff = new Date(Date.now() - AGE_MIN * 60 * 1000);

  // PENDING + PROCESSING — both can be stuck while DataShop already failed
  const { rows: stuck } = await query(
    `SELECT id, reference, provider_reference, user_id, amount, type, status, created_at
       FROM transactions
      WHERE UPPER(status) IN ('PROCESSING', 'PENDING')
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [cutoff, BATCH_LIMIT]
  );

  if (stuck.length === 0) {
    console.log('[reconciler] checked=0 settled=0 failed=0 gaveUp=0 skipped=0');
    return { checked: 0, settled: 0, failed: 0, gaveUp: 0, skipped: 0 };
  }

  let settled = 0, failed = 0, gaveUp = 0, skipped = 0;

  for (const tx of stuck) {
    const ageMin = (Date.now() - new Date(tx.created_at).getTime()) / 60000;
    // Prefer provider_reference (DataShop id) then our reference
    const lookupRefs = [
      tx.provider_reference,
      tx.reference,
    ].filter(Boolean);

    let applied = false;
    let lastErr = null;

    for (const lookupRef of lookupRefs) {
      try {
        const resp = await fetchDatashopStatus(lookupRef);
        const verdict = interpret(resp);
        const action = await applyVerdict(tx, verdict, ageMin);

        if (action === 'settled') settled++;
        else if (action === 'failed') failed++;
        else if (action === 'gaveUp') gaveUp++;
        else skipped++;

        applied = true;
        console.log(
          `[reconciler] ${tx.reference} db=${tx.status} age=${ageMin.toFixed(1)}m ` +
          `lookup=${lookupRef} verdict=${verdict.kind} → ${action}`
        );
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[reconciler] ${tx.reference} lookup=${lookupRef} error: ${err.message}`);
      }
    }

    if (!applied) {
      if (ageMin >= HARD_FAIL_MIN) {
        try {
          await processWebhook(
            tx.reference,
            'FAILED',
            `Hard timeout ${HARD_FAIL_MIN}m (provider unreachable) — auto-refunded`
          );
          gaveUp++;
        } catch (inner) {
          console.warn(`[reconciler] ${tx.reference} hard-fail write error: ${inner.message}`);
          skipped++;
        }
      } else {
        if (lastErr) console.warn(`[reconciler] ${tx.reference} skipped: ${lastErr.message}`);
        skipped++;
      }
    }
  }

  console.log(
    `[reconciler] checked=${stuck.length} settled=${settled} failed=${failed} gaveUp=${gaveUp} skipped=${skipped}`
  );
  return { checked: stuck.length, settled, failed, gaveUp, skipped };
}

/**
 * One-shot: force-sync a single reference against provider.
 * Safe to call from admin tools or status endpoint.
 */
export async function syncOneTransaction(reference) {
  const { rows } = await query(
    `SELECT id, reference, provider_reference, status, created_at
       FROM transactions WHERE reference = $1 LIMIT 1`,
    [reference]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };

  const tx = rows[0];
  const st = String(tx.status || '').toUpperCase();
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'REFUNDED') {
    return { ok: true, status: st, synced: false, reason: 'already_final' };
  }

  const ageMin = (Date.now() - new Date(tx.created_at).getTime()) / 60000;
  const lookupRefs = [tx.provider_reference, tx.reference].filter(Boolean);

  for (const lookupRef of lookupRefs) {
    try {
      const resp = await fetchDatashopStatus(lookupRef);
      const verdict = interpret(resp);
      const action = await applyVerdict(tx, verdict, Math.max(ageMin, NOT_FOUND_FAIL_MIN));
      return { ok: true, status: verdict.kind, action, lookupRef };
    } catch (err) {
      console.warn(`[syncOne] ${reference} ${lookupRef}: ${err.message}`);
    }
  }
  return { ok: false, code: 'PROVIDER_UNREACHABLE' };
}

/* Start cron — call once from server.js */
export function startReconcilerCron() {
  const INTERVAL_MS = 60 * 1000; // every 1 minute (was 2)
  console.log('[reconciler] cron started — every 1 min | PENDING+PROCESSING | provider is truth');
  const tick = async () => {
    try { await runReconciler(); }
    catch (e) { console.error('[reconciler] tick error:', e.message); }
  };
  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 8 * 1000);
}
