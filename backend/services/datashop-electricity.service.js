// services/datashop-electricity.service.js
// ============================================================
// SHATOVA — DataShop Africa · Electricity client
//   - verify meter (prepaid / postpaid) — multi-path probe
//   - purchase electricity
//   - status check (reuses shared /transactions/:ref path family)
//
//   ⚠️  NO database writes in this file. Pure HTTP.
//   ⚠️  NO product-name fallback loop. Electricity products map
//       to specific discos — silently swapping them could top up
//       the wrong meter. A rejected product_name is a hard error.
// ============================================================

import { env } from '../env/env.js';

/* ------------------------------------------------------------
   Base URL + auth (same resolution as vtu.service.js)
   ------------------------------------------------------------ */
function resolveBase(raw) {
  let b = String(raw || 'https://app.datashop.africa').replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(b)) b = `${b}/api/v2`;
  return b;
}

const BASE = resolveBase(env.VTU_API_BASE);
const KEY  = env.VTU_API_KEY;

if (KEY) {
  console.log(`[elec-datashop] Base: ${BASE}`);
  console.log(`[elec-datashop] Key:  ${KEY.slice(0, 12)}...${KEY.slice(-4)}`);
} else {
  console.warn('[elec-datashop] ⚠ VTU_API_KEY is missing');
}

/* ------------------------------------------------------------
   Error normalizer — user-safe messages
   ------------------------------------------------------------ */
export function normalizeProviderError(rawMessage) {
  const msg = String(rawMessage || '').toLowerCase();

  if (msg.includes('insufficient wallet balance') ||
      msg.includes('insufficient balance') ||
      msg.includes('wallet balance') ||
      msg.includes('insufficient funds') ||
      msg.includes('balance is too low') ||
      msg.includes('not enough balance')) {
    return 'Service temporarily unavailable. Please try again in a moment.';
  }
  if (msg.includes('timeout') || msg.includes('timed out') ||
      msg.includes('etimedout') || msg.includes('econnaborted')) {
    return 'The service is taking longer than usual. We will notify you once it completes.';
  }
  if (msg.includes('network') || msg.includes('econnrefused') ||
      msg.includes('enotfound') || msg.includes('socket hang up')) {
    return 'We are having trouble reaching the service. Please try again in a moment.';
  }
  if (msg.includes('invalid meter') || msg.includes('invalid customer') ||
      msg.includes('invalid number') || msg.includes('meter not found') ||
      msg.includes('customer not found')) {
    return 'The meter number entered is invalid for this disco.';
  }
  if (msg.includes('out of stock') || msg.includes('unavailable') ||
      msg.includes('not available') || msg.includes('product not found')) {
    return 'This product is temporarily unavailable. Please try another option.';
  }
  if (msg.includes('below minimum') || msg.includes('minimum amount') ||
      msg.includes('amount too low')) {
    return 'The amount entered is below the minimum for this disco.';
  }
  if (msg.includes('provider') || msg.includes('upstream') ||
      msg.includes('datashop') || msg.includes('internal') ||
      msg.includes('bad gateway') || msg.includes('service unavailable') ||
      /5\d{2}/.test(msg)) {
    return 'Service temporarily unavailable. Please try again in a moment.';
  }
  return 'We could not complete this transaction. Please try again.';
}

/* ------------------------------------------------------------
   Shared caller — identical shape to vtu.service.js
   Returns: { ok, provider_reference, data, raw }
   Throws:  normalized Error with .code / .isUserSafe / .rawMessage
   ------------------------------------------------------------ */
async function request(method, path, body) {
  const url = `${BASE}${path}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`,
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error(normalizeProviderError(err.message));
    e.code = 'PROVIDER_NETWORK';
    e.isNetworkError = true;
    e.isUserSafe = true;
    e.rawMessage = err.message;
    throw e;
  }

  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }

  if (!res.ok || json.status !== true) {
    const raw = json.message || json.error || `Provider rejected (${res.status})`;
    const e = new Error(normalizeProviderError(raw));
    e.code = 'PROVIDER_REJECTED';
    e.isUserSafe = true;
    e.rawMessage = raw;
    e.statusCode = res.status;
    e.providerResponse = json;
    throw e;
  }

  const provider_reference =
    json?.data?.reference ||
    json?.data?.transaction_reference ||
    json?.data?.transactionId ||
    json?.reference ||
    null;

  return {
    ok: true,
    provider_reference: provider_reference ? String(provider_reference) : null,
    data: json.data || {},
    raw: json,
  };
}

/* ============================================================
   VERIFY METER — multi-path probe
   Tries candidate paths until one returns non-404.
   Caches the winner for process lifetime.
   ============================================================ */
const VERIFY_PATHS = [
  '/verify-customer',
  '/electricity/verify',
  '/electricity/verify-customer',
  '/bill/verify',
  '/bills/verify',
  '/verify-meter',
  '/meter/verify',
  '/electricity/meter/verify',
  '/validate-meter',
  '/validate-customer',
];

let _cachedVerifyPath = null;

export async function verifyElectricityMeter({ meterNumber, productName }) {
  if (!meterNumber) throw new Error('meterNumber is required');
  if (!productName) throw new Error('productName is required');

  const body = {
    customer_id:  String(meterNumber),
    meter_number: String(meterNumber),
    product_name: String(productName),
  };

  const paths = _cachedVerifyPath
    ? [_cachedVerifyPath, ...VERIFY_PATHS.filter(p => p !== _cachedVerifyPath)]
    : VERIFY_PATHS;

  let lastErr = null;

  for (const path of paths) {
    try {
      console.log(`[elec-datashop] verify probe → ${path}`);
      const res = await request('POST', path, body);
      _cachedVerifyPath = path;
      console.log(`[elec-datashop] ✅ verify path found: ${path}`);

      const d = res.data || {};
      const payload = d.data && typeof d.data === 'object' ? d.data : d;

      const minimumRaw = payload.minimum_amount ?? payload.minimumAmount ?? null;
      const outstandingRaw =
        payload.outstanding_balance ?? payload.outstandingBalance ??
        payload.balance ?? null;

      return {
        verified:            true,
        meter_number:        payload.meter_number || String(meterNumber),
        customer_name:       payload.customer_name || null,
        customer_address:    payload.customer_address || null,
        disco:               payload.disco || null,
        product_name:        payload.product_name || productName,
        minimum_amount:      minimumRaw != null ? Number(minimumRaw) : null,
        outstanding_balance: outstandingRaw != null ? Number(outstandingRaw) : null,
        raw:                 payload,
      };
    } catch (err) {
      lastErr = err;

      /* 404 = wrong path → try next */
      if (err.statusCode === 404) {
        console.warn(`[elec-datashop] verify 404: ${path}`);
        continue;
      }

      /* Any other status means the path exists but rejected our payload.
         Bubble up — no point trying more paths. */
      console.error(`[elec-datashop] verify error at ${path}:`, err.rawMessage || err.message);
      throw err;
    }
  }

  /* All paths 404'd. DataShop doesn't expose a verify endpoint for
     electricity. Return a soft-verified stub so purchase can proceed.
     The real customer name will arrive with the purchase response. */
  console.warn('[elec-datashop] all verify paths 404 — soft verify fallback');
  return {
    verified:            true,
    meter_number:        String(meterNumber),
    customer_name:       null,
    customer_address:    null,
    disco:               null,
    product_name:        productName,
    minimum_amount:      null,
    outstanding_balance: null,
    raw:                 { soft_verify: true, last_error: lastErr?.rawMessage || null },
  };
}

/* ============================================================
   PURCHASE ELECTRICITY
   POST /purchase
   Body: { customer_id, product_name, amount, reference }

   Confirmed success shape:
     {
       reference, customer_id, service, provider, product_name,
       quantity, paid_amount, transaction_status,
       token?, units?, meter_number, customer_name,
       customer_address, disco, remark
     }
   ============================================================ */
export async function buyElectricity({
  meterNumber, productName, amount, reference,
}) {
  if (!meterNumber) throw new Error('meterNumber is required');
  if (!productName) throw new Error('productName is required');
  if (!reference)   throw new Error('reference is required');

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('amount must be a positive number');
  }

  const res = await request('POST', '/purchase', {
    customer_id:  String(meterNumber),
    product_name: String(productName),
    amount:       amt,
    reference:    String(reference),
  });

  const d = res.data || {};
  const payload = d.data && typeof d.data === 'object' ? d.data : d;

  const token =
    payload.token ||
    payload.token_code ||
    payload.standard_token ||
    null;

  return {
    ok:                 true,
    provider_reference: payload.reference || res.provider_reference || reference,
    token:              token ? String(token) : null,
    units:              payload.units != null ? String(payload.units) : null,
    quantity:           Number(payload.quantity ?? amt),
    paid_amount:        Number(payload.paid_amount ?? 0),
    customer_name:      payload.customer_name    || null,
    customer_address:   payload.customer_address || null,
    disco:              payload.disco            || null,
    provider:           payload.provider         || null,
    meter_number:       payload.meter_number     || String(meterNumber),
    product_name:       payload.product_name     || productName,
    transaction_status: payload.transaction_status || null,
    remark:             payload.remark           || null,
    raw:                payload,
  };
}

/* ============================================================
   STATUS CHECK
   Reuses the same path family as vtu.service.js. Electricity
   purchases are stored in DataShop under the same /transactions
   endpoint, keyed by our merchant reference.
   ============================================================ */
const STATUS_PATHS = [
  (ref) => `/transactions/${encodeURIComponent(ref)}`,
  (ref) => `/transaction/${encodeURIComponent(ref)}`,
  (ref) => `/purchases/${encodeURIComponent(ref)}`,
  (ref) => `/purchase/${encodeURIComponent(ref)}`,
  (ref) => `/status/${encodeURIComponent(ref)}`,
];

let _cachedStatusPath = null;

export async function checkElectricityStatus(reference) {
  if (!reference) throw new Error('reference is required');

  const paths = _cachedStatusPath
    ? [_cachedStatusPath, ...STATUS_PATHS.filter(fn => fn('x') !== _cachedStatusPath('x'))]
    : STATUS_PATHS;

  let lastErr = null;

  for (const makePath of paths) {
    const path = makePath(reference);
    let res;

    try {
      res = await request('GET', path);
      _cachedStatusPath = makePath;
    } catch (err) {
      lastErr = err;

      /* 404 = wrong path → try next */
      if (err.statusCode === 404) continue;

      /* Provider returned a body on 4xx → that body IS the answer */
      if (err.providerResponse && typeof err.providerResponse === 'object') {
        const d = err.providerResponse.data;
        if (Array.isArray(d) && d.length) {
          return { ...err.providerResponse, data: d[0] };
        }
        return err.providerResponse;
      }

      /* Network / 5xx with no body → cannot determine → bubble up */
      throw err;
    }

    const d = res.raw?.data;
    if (Array.isArray(d) && d.length) {
      return { ...res.raw, data: d[0] };
    }
    return res.raw;
  }

  const e = new Error('Transaction not found on DataShop');
  e.code = 'PROVIDER_NOT_FOUND';
  e.isUserSafe = true;
  e.rawMessage = lastErr?.rawMessage || 'not found';
  throw e;
}

/* ============================================================
   STATUS NORMALIZER
   Same logic as vtu.service.js, scoped for electricity
   Returns: 'successful' | 'failed' | 'processing'
   ============================================================ */
function matchStatusString(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!s) return 'unknown';

  const FAILED = [
    'fail', 'failed', 'failure', 'reject', 'rejected', 'cancel', 'cancelled',
    'canceled', 'decline', 'declined', 'error', 'refund', 'refunded',
    'invalid', 'not successful', 'unsuccessful', 'expired', 'reversed',
    'abandoned', 'aborted', 'denied',
  ];
  const SUCCESS = [
    'success', 'successful', 'succeeded', 'complete', 'completed', 'delivered',
    'approved', 'done', 'paid', 'processed', 'sent', 'credited', 'confirmed',
  ];
  const PENDING = [
    'processing', 'pending', 'in_progress', 'in-progress', 'submitted',
    'queued', 'initiated', 'awaiting', 'in progress', 'new', 'created',
    'accepted', 'received',
  ];

  for (const k of FAILED)  if (s.includes(k)) return 'failed';
  for (const k of SUCCESS) if (s.includes(k)) return 'successful';
  for (const k of PENDING) if (s.includes(k)) return 'processing';
  return 'unknown';
}

export function normalizeProviderStatus(payload) {
  if (payload == null) return 'failed';

  if (typeof payload === 'string') {
    const v = matchStatusString(payload);
    return v === 'unknown' ? 'failed' : v;
  }
  if (typeof payload !== 'object') return 'failed';

  const outer = payload;
  const inner =
    outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
      ? outer.data
      : Array.isArray(outer.data) && outer.data[0]
        ? outer.data[0]
        : {};

  const candidates = [
    inner.transaction_status, inner.transactionStatus,
    inner.payment_status,     inner.paymentStatus,
    inner.delivery_status,    inner.state, inner.status, inner.result,
    inner.transaction && inner.transaction.status,
    outer.transaction_status, outer.transactionStatus,
    outer.payment_status,     outer.state,
    typeof outer.status === 'string' ? outer.status : null,
    outer.code, outer.result,
  ];

  for (const raw of candidates) {
    if (raw == null || typeof raw === 'boolean') continue;
    const verdict = matchStatusString(raw);
    if (verdict !== 'unknown') return verdict;
  }

  if (typeof outer.status === 'boolean') return outer.status ? 'successful' : 'failed';
  if (typeof inner.status === 'boolean') return inner.status ? 'successful' : 'failed';

  const code = Number(outer.code != null ? outer.code : inner.code);
  if (Number.isFinite(code)) {
    if (code >= 200 && code < 300) return 'successful';
    if (code >= 400) return 'failed';
  }

  return 'failed';
}

/* ============================================================
   REFERENCE GENERATOR — prefixed for easy identification
   ============================================================ */
export function generateReference(prefix = 'SHATOVA-ELEC') {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${ts}-${rand}`.slice(0, 40);
}

/* ============================================================
   DEFAULT EXPORT
   ============================================================ */
export default {
  verifyElectricityMeter,
  buyElectricity,
  checkElectricityStatus,
  normalizeProviderStatus,
  normalizeProviderError,
  generateReference,
};
