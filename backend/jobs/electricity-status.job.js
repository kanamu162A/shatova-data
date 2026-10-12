// jobs/electricity-status.job.js
// ============================================================
// SHATOVA — Electricity Status Job
//   Runs every 60s. Reconciles PROCESSING/PENDING electricity tx.
// ============================================================

import { reconcileProcessingElectricityTransactions } from '../services/electricity.service.js';

const INTERVAL_MS = 60 * 1000;
const BATCH_SIZE  = 25;

let timer = null;
let running = false;

export function startElectricityStatusJob() {
  if (timer) return;
  console.log('[electricity-status] Job started — every 60s');

  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileProcessingElectricityTransactions(BATCH_SIZE);
      if (result.checked) {
        console.log(`[electricity-status] ${JSON.stringify(result)}`);
      }
    } catch (err) {
      console.error('[electricity-status] job error:', err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}

export function stopElectricityStatusJob() {
  if (timer) { clearInterval(timer); timer = null; }
}
