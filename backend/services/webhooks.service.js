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

const AGE_MIN = 5;

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

function interpret(resp) {
  const b = resp.body;
  if (!b) return { kind: 'UNKNOWN' };

  const raw = String(
    b.transaction_status || b.status || b.data?.transaction_status || b.data?.status || ''
  ).toLowerCase();

  if (['successful','success','completed','approved','paid','delivered','done'].some(x => raw.includes(x))) {
    return { kind: 'SUCCESS', remark: b.message || b.remark || 'Delivered' };
  }
  if (['failed','failure','rejected','cancelled','canceled','error','refunded','reversed','invalid'].some(x => raw.includes(x))) {
    return { kind: 'FAILED', remark: b.message || b.remark || 'Failed' };
  }
  if (resp.httpStatus === 404) return { kind: 'NOT_FOUND' };
  if (raw.includes('not found') || String(b.message || '').toLowerCase().includes('not found')) {
    return { kind: 'NOT_FOUND' };
  }

  return { kind: 'PENDING', remark: b.message || raw };
}

export async function runReconciler() {
  const cutoff = new Date(Date.now() - AGE_MIN * 60 * 1000);

  const { rows: stuck } = await query(
    `SELECT id, reference, user_id, amount, created_at
       FROM transactions
      WHERE status = 'PROCESSING'
        AND type = 'DATA'
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT 50`,
    [cutoff]
  );

  if (stuck.length === 0) {
    console.log('[reconciler] checked=0 settled=0 failed=0 gaveUp=0 skipped=0');
    return;
  }

  let settled = 0, failed = 0, gaveUp = 0, skipped = 0;

  for (const tx of stuck) {
    const ageMin = (Date.now() - new Date(tx.created_at).getTime()) / 60000;

    try {
      const resp = await fetchDatashopStatus(tx.reference);
      const verdict = interpret(resp);

      if (verdict.kind === 'SUCCESS') {
        await processWebhook(tx.reference, 'SUCCESS', verdict.remark);
        settled++;
      } else if (verdict.kind === 'FAILED') {
        await processWebhook(tx.reference, 'FAILED', verdict.remark);
        failed++;
      } else if (verdict.kind === 'NOT_FOUND') {
        if (ageMin >= 30) {
          await processWebhook(tx.reference, 'FAILED', 'Not found on DataShop — auto-refunded');
          failed++;
        } else {
          skipped++;
        }
      } else {
        if (ageMin >= 60) {
          await processWebhook(tx.reference, 'FAILED', 'Timed out after 60m — auto-refunded');
          gaveUp++;
        } else {
          skipped++;
        }
      }
    } catch (err) {
      console.warn(`[reconciler] ${tx.reference} error: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[reconciler] checked=${stuck.length} settled=${settled} failed=${failed} gaveUp=${gaveUp} skipped=${skipped}`);
}

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