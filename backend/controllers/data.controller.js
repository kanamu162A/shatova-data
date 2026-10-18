// controllers/data.controller.js
// ============================================================
// Shatova — Data Controller (HTTP layer only)
//   ⭐ Thin layer — all business logic in data.service.js
//   ⭐ Wraps every response in { success, data } or { success, error }
//   ⭐ Now handles TIMEOUT-SAFE purchases:
//      - status: 'success'    → 200
//      - status: 'processing' → 200 (ambiguous — user sees "Processing")
//      - status: 'failed'     → 200 (with failure data; frontend shows error)
//      - definite 4xx from provider → 502
//   ⭐ v11 changes (only these):
//      - PLAN_UNAVAILABLE now 409 (refresh signal)
//      - PRICE_CHANGED now 409 (loss guard signal)
//      - getPurchaseSummary() appended
// ============================================================

import * as dataService from '../services/data.service.js';

/* ============================================================
   GET /data/networks
   ============================================================ */
export async function getNetworks(req, res) {
  try {
    const networks = await dataService.getNetworks();
    res.json({ success: true, data: { networks } });
  } catch (err) {
    console.error('[data.getNetworks]', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to load networks',
    });
  }
}

/* ============================================================
   GET /data/categories?network=all
   ============================================================ */
export async function getCategories(req, res) {
  try {
    const network = String(req.query.network || 'all');
    const categories = await dataService.getCategories(network);
    res.json({ success: true, data: { categories } });
  } catch (err) {
    console.error('[data.getCategories]', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to load categories',
    });
  }
}

/* ============================================================
   GET /data/bundles?network=mtn[&category=SHARE]
   ============================================================ */
export async function getBundles(req, res) {
  try {
    const network  = String(req.query.network  || '').toLowerCase();
    const category = String(req.query.category || '');

    if (!network) {
      return res.status(400).json({
        success: false,
        message: 'network is required',
      });
    }

    const bundles = await dataService.getBundles({ network, category });
    res.json({ success: true, data: { bundles } });
  } catch (err) {
    console.error('[data.getBundles]', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to load bundles',
    });
  }
}

/* ============================================================
   POST /data/verify-customer
   Body: { phone, product_name }
   ============================================================ */
export async function verifyCustomer(req, res) {
  try {
    const { phone, product_name, plan_id } = req.body || {};
    const productName = product_name || plan_id;

    if (!phone || !productName) {
      return res.status(400).json({
        success: false,
        message: 'phone and product_name are required',
      });
    }

    const result = await dataService.verifyCustomer({ phone, productName });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[data.verifyCustomer]', err);
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Verification failed',
    });
  }
}

/* ============================================================
   POST /data/purchase
   Body: { plan_id, phone, mode, payment_method }
   ------------------------------------------------------------
   Response shapes:

   ✅ SUCCESS
      200 { success: true, data: { status: 'success', reference, ... } }

   ⏳ PROCESSING (ambiguous — timeout / network died)
      200 { success: true, data: { status: 'processing', ambiguous: true,
                                    reference, remark, ... } }

   ❌ FAILED (Datashop explicitly rejected)
      200 { success: true, data: { status: 'failed', reference, remark, ... } }

   🚫 INSUFFICIENT BALANCE
      400 { success: false, code: 'INSUFFICIENT_BALANCE', message, data }

   🚫 INVALID PHONE / PLAN
      400 { success: false, code: 'INVALID_PHONE' | 'INVALID_PLAN', ... }

   🚫 PLAN UNAVAILABLE
      409 { success: false, code: 'PLAN_UNAVAILABLE', message }

   🚫 PRICE CHANGED (sell_price < cost_price — loss guard)
      409 { success: false, code: 'PRICE_CHANGED', message, data: { plan_id, live_cost, sell_price } }

   🚫 PROVIDER ERROR (unrecoverable from service's perspective)
      502 { success: false, code: 'PURCHASE_FAILED', message }
   ============================================================ */
export async function purchase(req, res) {
  const userId = req.user?._id || req.user?.id || req.user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const {
    plan_id,
    phone,
    mode = 'single',
    payment_method = 'wallet',
  } = req.body || {};

  if (!plan_id || !phone) {
    return res.status(400).json({
      success: false,
      message: 'plan_id and phone are required',
    });
  }

  try {
    const result = await dataService.purchaseData({
      userId,
      planId: plan_id,
      phone,
      mode,
      paymentMethod: payment_method,
    });

    /* ─────────────────────────────────────────────────────────
       purchaseData never throws for ambiguous timeouts —
       it returns a result with status: 'success' | 'processing' | 'failed'.
       All three are "successful API calls" from the client's perspective,
       so we return 200 and let the frontend branch on `result.status`.
       ───────────────────────────────────────────────────────── */
    const httpStatus = 200;

    /* Tag the response so the frontend knows exactly what happened */
    const payload = {
      ...result,
      /* Explicit field so frontend can never miss the case */
      outcome:
        result.status === 'success'    ? 'success'    :
        result.status === 'processing' ? 'processing' :
        result.status === 'failed'     ? 'failed'     :
        'unknown',
      /* When ambiguous, expose a client-friendly hint */
      hint: result.ambiguous
        ? 'We are confirming with the provider. This will finish shortly.'
        : null,
    };

    res.status(httpStatus).json({ success: true, data: payload });
  } catch (err) {
    /* Only DEFINITE errors land here (service re-throws those).
       Ambiguous timeouts never reach this catch — they return
       as status: 'processing' above. */
    console.error('[data.purchase]', err);

    const code = err.code || 'PURCHASE_FAILED';

    const status =
      code === 'INSUFFICIENT_BALANCE' ? 400 :
      code === 'NETWORK_MISMATCH'     ? 400 :
      code === 'INVALID_PHONE'        ? 400 :
      code === 'INVALID_PLAN'         ? 400 :
      code === 'PLAN_UNAVAILABLE'     ? 409 :
      code === 'PRICE_CHANGED'        ? 409 :
      code === 'PRODUCT_NOT_FOUND'    ? 404 :
      code === 'PROVIDER_REJECTED'    ? 502 :
      code === 'PURCHASE_FAILED'      ? 502 :
      500;

    res.status(status).json({
      success: false,
      code,
      message: err.message || 'Purchase failed',
      data:    err.data  || null,
    });
  }
}

/* ============================================================
   GET /data/status?reference=...
   ------------------------------------------------------------
   Used by the frontend to poll while a tx is PROCESSING.
   Also auto-releases/drops the wallet hold if status changed.

   Response shapes:

   ✅ 200 { success: true, data: { status: 'success',    reference, ... } }
   ❌ 200 { success: true, data: { status: 'failed',     reference, ... } }
   ⏳ 200 { success: true, data: { status: 'processing', reference, ... } }
   ============================================================ */
export async function getStatus(req, res) {
  try {
    const reference = String(req.query.reference || '').trim();
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: 'reference is required',
      });
    }

    const data = await dataService.getStatus(reference);

    /* Normalize the status field so the frontend can rely on it */
    const normalizedStatus =
      data.status === 'success'    ? 'success'    :
      data.status === 'failed'     ? 'failed'     :
      data.status === 'processing' ? 'processing' :
      data.status === 'pending'    ? 'processing' :
      'processing';

    res.json({
      success: true,
      data: {
        ...data,
        status: normalizedStatus,
      },
    });
  } catch (err) {
    console.error('[data.getStatus]', err);
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to fetch status',
    });
  }
}

/* ============================================================
   GET /data/summary   (appended)
   ------------------------------------------------------------
   200 {
     success: true,
     data: {
       today:     { count, total, success, failed, processing },
       yesterday: { count, total, success, failed, processing }
     }
   }
   ============================================================ */
export async function getPurchaseSummary(req, res) {
  try {
    const userId = req.user?._id || req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const summary = await dataService.getPurchaseSummary(userId);
    res.json({ success: true, data: summary });
  } catch (err) {
    console.error('[data.getPurchaseSummary]', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to load summary',
    });
  }
}

/* ============================================================
   Default export
   ============================================================ */
export default {
  getNetworks,
  getCategories,
  getBundles,
  verifyCustomer,
  purchase,
  getStatus,
  getPurchaseSummary,
};
