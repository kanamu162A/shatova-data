// services/reconciler.service.js
// ============================================================
// Shatova — Reconciler
//   ⭐ Backup for missed webhooks
//   ⭐ Polls DataShop for PROCESSING txs older than N minutes
//   ⭐ Uses the SAME processWebhook (idempotent → safe)
// ============================================================

import { query } from '../config/database.js';
import { processWebhook } from '../controllers/webhook.controller.js';
import { env } from '../env/env.js';

const DS_BASE = env.VTU_API_BASE;
const DS_KEY  = env.VTU_API_KEY;
const DS_STATUS_PATH = env.DATASHOP_STATUS_ENDPOINT || '/transaction/status';

// ─── Tunables ───────────────────────────────────────────────
const AGE_MIN         = 5;   // only look at txs older than this
const NOT_FOUND_FAIL_MIN = 2;   // provider says "not found" → fail after 2m (was 30)
const PENDING_FAIL_MIN   = 15;  // provider says "pending"   → fail after 15m (was 60)
const HARD_FAIL_MIN      = 45;  // absolute cap — fail no matter what
const BATCH_LIMIT        = 100; // was 50

// ─── Fetch provider status ──────────────────────────────────
async function fetchDatashopStatus(reference) {
  const url = `${DS_BASE}${DS_STATUS_PATH}?reference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${DS_KEY}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }

  return { httpStatus: res.status, body, raw: text };
}

// ─── Interpret provider response ────────────────────────────
// Returns { kind: 'SUCCESS' | 'FAILED' | 'PENDING' | 'NOT_FOUND' | 'UNKNOWN', remark }
function interpret(resp) {
  const b = resp.body;

  // HTTP 404 is the clearest signal
  if (resp.httpStatus === 404) return { kind: 'NOT_FOUND', remark: 'HTTP 404' };

  if (!b) return { kind: 'UNKNOWN', remark: `HTTP ${resp.httpStatus}` };

  // Collect every plausible status field — same fields your webhook uses
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
    'fail','failed','failure','reject','rejected','cancel','cancelled','canceled',
    'decline','declined','error','refund','refunded','reversed','invalid',
    'not successful','unsuccessful','expired','abandoned','aborted','denied',
    'timeout','timed out','not found',
  ];
  const SUCCESS_KEYS = [
    'success','successful','succeeded','complete','completed','delivered',
    'approved','done','paid','processed','sent','credited','confirmed',
  ];
  const PENDING_KEYS = [
    'processing','pending','in_progress','in-progress','submitted',
    'queued','initiated','awaiting','in progress','new','created',
    'accepted','received',
  ];

  for (const raw of candidates) {
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;

    // FAILED before SUCCESS so "not successful" → failed
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

  // Check message text as a last resort
  const msg = String(b.message || b.remark || '').toLowerCase();
  if (msg.includes('not found')) return { kind: 'NOT_FOUND', remark: msg };
  if (FAILED_KEYS.some((k) => msg.includes(k))) {
    return { kind: 'FAILED', remark: b.message || msg };
  }
  if (SUCCESS_KEYS.some((k) => msg.includes(k))) {
    return { kind: 'SUCCESS', remark: b.message || msg };
  }

  // Boolean status field
  if (typeof b.status === 'boolean') {
    return b.status
      ? { kind: 'SUCCESS', remark: 'Boolean status true' }
      : { kind: 'FAILED',  remark: 'Boolean status false' };
  }

  // Array response (DataShop sometimes returns lists)
  if (Array.isArray(b.data) && b.data[0]) {
    return interpret({ httpStatus: resp.httpStatus, body: b.data[0] });
  }

  return { kind: 'PENDING', remark: b.message || 'Unknown state' };
}

// ─── Main reconciler ────────────────────────────────────────
export async function runReconciler() {
  const cutoff = new Date(Date.now() - AGE_MIN * 60 * 1000);

  // ⚠️ FIX #1: no type filter — reconcile ALL processing transactions
  const { rows: stuck } = await query(
    `SELECT id, reference, provider_reference, user_id, amount, type, created_at
       FROM transactions
      WHERE status = 'PROCESSING'
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [cutoff, BATCH_LIMIT]
  );

  if (stuck.length === 0) {
    console.log('[reconciler] checked=0 settled=0 failed=0 gaveUp=0 skipped=0');
    return;
  }

  let settled = 0, failed = 0, gaveUp = 0, skipped = 0;

  for (const tx of stuck) {
    const ageMin = (Date.now() - new Date(tx.created_at).getTime()) / 60000;

    // ⚠️ FIX #4: prefer provider_reference when available
    const lookupRef = tx.provider_reference || tx.reference;

    try {
      const resp = await fetchDatashopStatus(lookupRef);
      const verdict = interpret(resp);

      if (verdict.kind === 'SUCCESS') {
        await processWebhook(tx.reference, 'SUCCESS', verdict.remark);
        settled++;
        continue;
      }

      if (verdict.kind === 'FAILED') {
        await processWebhook(tx.reference, 'FAILED', verdict.remark);
        failed++;
        continue;
      }

      if (verdict.kind === 'NOT_FOUND') {
        // ⚠️ FIX #3: fail after 2 min, not 30
        if (ageMin >= NOT_FOUND_FAIL_MIN) {
          await processWebhook(tx.reference, 'FAILED',
            `Not found on DataShop after ${NOT_FOUND_FAIL_MIN}m — auto-refunded`);
          failed++;
        } else {
          skipped++;
        }
        continue;
      }

      // PENDING or UNKNOWN
      // ⚠️ FIX #2: age-based pessimistic fallback
      if (ageMin >= HARD_FAIL_MIN) {
        await processWebhook(tx.reference, 'FAILED',
          `Hard timeout ${HARD_FAIL_MIN}m — auto-refunded`);
        gaveUp++;
      } else if (ageMin >= PENDING_FAIL_MIN) {
        await processWebhook(tx.reference, 'FAILED',
          `Provider still pending after ${PENDING_FAIL_MIN}m — auto-refunded`);
        gaveUp++;
      } else {
        skipped++;
      }
    } catch (err) {
      // Network / timeout → check HARD_FAIL_MIN cap
      if (ageMin >= HARD_FAIL_MIN) {
        try {
          await processWebhook(tx.reference, 'FAILED',
            `Hard timeout ${HARD_FAIL_MIN}m (provider unreachable) — auto-refunded`);
          gaveUp++;
        } catch (inner) {
          console.warn(`[reconciler] ${tx.reference} hard-fail write error: ${inner.message}`);
          skipped++;
        }
      } else {
        console.warn(`[reconciler] ${tx.reference} error: ${err.message}`);
        skipped++;
      }
    }
  }

  console.log(
    `[reconciler] checked=${stuck.length} settled=${settled} failed=${failed} gaveUp=${gaveUp} skipped=${skipped}`
  );
}

/* Start cron — call once from server.js */
export function startReconcilerCron() {
  const INTERVAL_MS = 2 * 60 * 1000;
  console.log('[reconciler] cron started — every 2 min');

  const tick = async () => {
    try { await runReconciler(); }
    catch (e) { console.error('[reconciler] tick error:', e.message); }
  };

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 10 * 1000);
}
