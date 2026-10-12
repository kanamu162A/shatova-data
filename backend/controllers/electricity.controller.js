// controllers/electricity.controller.js
// ============================================================
// SHATOVA — Electricity Controller (thin HTTP layer)
//   Mirrors controllers/data.controller.js exactly.
// ============================================================

import * as electricityService from '../services/electricity.service.js';

/* GET /api/v1/electricity/products */
export async function getProducts(req, res) {
  try {
    const data = await electricityService.getProducts();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[electricity.getProducts]', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load products' });
  }
}

/* POST /api/v1/electricity/verify */
export async function verifyMeter(req, res) {
  try {
    const { product_name, meter_number } = req.body || {};
    if (!product_name || !meter_number) {
      return res.status(400).json({
        success: false,
        message: 'product_name and meter_number are required',
      });
    }

    const result = await electricityService.verifyMeter({
      productName: product_name,
      meterNumber: meter_number,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[electricity.verifyMeter]', err);
    res.status(err.statusCode || 400).json({
      success: false,
      code:    err.code || 'VERIFY_FAILED',
      message: err.message || 'Verification failed',
    });
  }
}

/* POST /api/v1/electricity/purchase */
export async function purchase(req, res) {
  const userId = req.user?._id || req.user?.id || req.user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const {
    product_name,
    meter_number,
    amount,
    payment_method = 'wallet',
  } = req.body || {};

  if (!product_name || !meter_number || !amount) {
    return res.status(400).json({
      success: false,
      message: 'product_name, meter_number and amount are required',
    });
  }

  try {
    const result = await electricityService.purchaseElectricity({
      userId,
      productName:   product_name,
      meterNumber:   meter_number,
      amount,
      paymentMethod: payment_method,
    });

    res.status(200).json({
      success: true,
      data: {
        ...result,
        outcome:
          result.status === 'success'    ? 'success'    :
          result.status === 'processing' ? 'processing' :
          result.status === 'failed'     ? 'failed'     : 'unknown',
        hint: result.ambiguous
          ? 'We are confirming with the provider. This will finish shortly.'
          : null,
      },
    });
  } catch (err) {
    console.error('[electricity.purchase]', err);

    const code = err.code || 'PURCHASE_FAILED';
    const status =
      code === 'INSUFFICIENT_BALANCE'  ? 400 :
      code === 'WALLET_NOT_FOUND'      ? 400 :
      code === 'WALLET_INACTIVE'       ? 400 :
      code === 'INVALID_METER'         ? 400 :
      code === 'INVALID_PRODUCT'       ? 404 :
      code === 'PRODUCT_UNAVAILABLE'   ? 400 :
      code === 'INVALID_AMOUNT'        ? 400 :
      code === 'AMOUNT_TOO_LOW'        ? 400 :
      code === 'AMOUNT_TOO_HIGH'       ? 400 :
      code === 'PROVIDER_REJECTED'     ? 502 :
      code === 'PURCHASE_FAILED'       ? 502 :
      500;

    res.status(status).json({
      success: false,
      code,
      message: err.message || 'Purchase failed',
      data:    err.data || null,
    });
  }
}

/* GET /api/v1/electricity/status?reference=... */
export async function getStatus(req, res) {
  try {
    const reference = String(req.query.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ success: false, message: 'reference is required' });
    }

    const data = await electricityService.getStatus(reference);

    const normalizedStatus =
      data.status === 'success'    ? 'success'    :
      data.status === 'failed'     ? 'failed'     :
      data.status === 'pending'    ? 'processing' :
      data.status === 'processing' ? 'processing' : 'processing';

    res.json({ success: true, data: { ...data, status: normalizedStatus } });
  } catch (err) {
    console.error('[electricity.getStatus]', err);
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to fetch status',
    });
  }
}

/* GET /api/v1/electricity/history */
export async function getHistory(req, res) {
  try {
    const userId = req.user?._id || req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const items = await electricityService.getHistory({ userId, limit });
    res.json({ success: true, data: { items } });
  } catch (err) {
    console.error('[electricity.getHistory]', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load history' });
  }
}

export default { getProducts, verifyMeter, purchase, getStatus, getHistory };
