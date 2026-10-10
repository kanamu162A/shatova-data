// services/vtu.service.js
// ============================================================
// DataShop Africa VTU client
//   Networks: MTN · Airtel · Glo · T2
// ============================================================

import { env } from '../env/env.js';

function resolveBase(raw) {
  let b = String(raw || 'https://app.datashop.africa').replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(b)) b = `${b}/api/v2`;
  return b;
}

const BASE = resolveBase(env.VTU_API_BASE);
const KEY  = env.VTU_API_KEY;

if (KEY) {
  console.log(`[vtu] Base: ${BASE}`);
  console.log(`[vtu] Key:  ${KEY.slice(0, 12)}...${KEY.slice(-4)}`);
} else {
  console.warn('[vtu] ⚠ VTU_API_KEY is missing');
}

/* ============================================================
   ERROR NORMALIZER  (unchanged — working)
   ============================================================ */
export function normalizeProviderError(rawMessage) {
  const msg = String(rawMessage || '').toLowerCase();

  if (msg.includes('insufficient wallet balance') ||
      msg.includes('insufficient balance') ||
      msg.includes('wallet balance') ||
      msg.includes('insufficient funds') ||
      msg.includes('balance is too low') ||
      msg.includes('not enough balance') ||
      msg.includes('hold')) {
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
  if (msg.includes('invalid phone') || msg.includes('invalid customer') ||
      msg.includes('invalid number')) {
    return 'The phone number entered is invalid for this network.';
  }
  if (msg.includes('out of stock') || msg.includes('unavailable') ||
      msg.includes('not available') || msg.includes('product not found')) {
    return 'This product is temporarily unavailable. Please try another option.';
  }
  if (msg.includes('provider') || msg.includes('upstream') ||
      msg.includes('datashop') || msg.includes('internal') ||
      msg.includes('bad gateway') || msg.includes('service unavailable') ||
      /5\d{2}/.test(msg)) {
    return 'Service temporarily unavailable. Please try again in a moment.';
  }
  return 'We could not complete this transaction. Please try again.';
}

/* ============================================================
   STATUS NORMALIZER — strict, terminal-biased  (REPLACED)
   Returns ONLY: 'successful' | 'failed' | 'processing'
   ============================================================ */

// Internal helper — returns 'successful' | 'failed' | 'processing' | 'unknown'
function matchStatusString(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!s) return 'unknown';

  // FAILED must be checked BEFORE success, so "not successful" → failed
  const FAILED = [
    'fail', 'failed', 'failure', 'reject', 'rejected', 'cancel', 'cancelled',
    'canceled', 'decline', 'declined', 'error', 'refund', 'refunded',
    'invalid', 'not successful', 'unsuccessful', 'expired', 'reversed',
    'abandoned', 'aborted', 'denied', 'timeout', 'timed out',
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
  // No payload → we cannot confirm → treat as failed.
  // Caller decides whether to retry; default must NOT be 'processing'.
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

  // Every plausible status signal, in priority order
  const candidates = [
    inner.transaction_status,
    inner.transactionStatus,
    inner.payment_status,
    inner.paymentStatus,
    inner.delivery_status,
    inner.state,
    inner.status,
    inner.result,
    inner.transaction && inner.transaction.status,
    outer.transaction_status,
    outer.transactionStatus,
    outer.payment_status,
    outer.state,
    typeof outer.status === 'string' ? outer.status : null,
    outer.code,
    outer.result,
  ];

  for (const raw of candidates) {
    if (raw == null || typeof raw === 'boolean') continue;
    const verdict = matchStatusString(raw);
    if (verdict !== 'unknown') return verdict;
  }

  // Boolean status is authoritative
  if (typeof outer.status === 'boolean') {
    return outer.status ? 'successful' : 'failed';
  }
  if (typeof inner.status === 'boolean') {
    return inner.status ? 'successful' : 'failed';
  }

  // HTTP-style code fallback
  const code = Number(outer.code != null ? outer.code : inner.code);
  if (Number.isFinite(code)) {
    if (code >= 200 && code < 300) return 'successful';
    if (code >= 400) return 'failed';
  }

  // ⚠️ Unknown → FAILED, never 'processing'
  return 'failed';
}

/* ============================================================
   SHARED CALLER  (unchanged — working)
   ============================================================ */
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
   PROVIDER BALANCE  (unchanged — working)
   ============================================================ */
const BALANCE_PATHS = [
  '/account/wallet-balance',
  '/account/balance',
  '/wallet/balance',
  '/wallet',
  '/balance',
];

let _cachedBalancePath = null;

export async function getDatashopBalance() {
  const paths = _cachedBalancePath
    ? [_cachedBalancePath, ...BALANCE_PATHS.filter(p => p !== _cachedBalancePath)]
    : BALANCE_PATHS;

  for (const path of paths) {
    try {
      const res = await request('GET', path);
      const b = res.data?.balance
             ?? res.data?.wallet_balance
             ?? res.data?.walletBalance
             ?? res.data?.wallet?.balance
             ?? null;
      if (b != null && !Number.isNaN(Number(b))) {
        _cachedBalancePath = path;
        return Number(b);
      }
    } catch (err) {
      if (err.statusCode && err.statusCode !== 404) {
        console.warn(`[vtu] balance ${path}:`, err.rawMessage || err.message);
      }
    }
  }
  return null;
}

export const getProviderBalance = getDatashopBalance;

/* ============================================================
   PRODUCTS  (unchanged — working)
   ============================================================ */
const PRODUCT_PATHS = ['/list-products', '/products', '/get-products'];
let _cachedProductPath = null;

export async function listProducts({ service = 'airtime', provider, network } = {}) {
  const paths = _cachedProductPath
    ? [_cachedProductPath, ...PRODUCT_PATHS.filter(p => p !== _cachedProductPath)]
    : PRODUCT_PATHS;

  const params = new URLSearchParams();
  if (service)  params.set('service', service);
  if (provider) params.set('provider', provider);
  if (network)  params.set('network', network);
  const qs = params.toString();

  for (const path of paths) {
    try {
      const res = await request('GET', `${path}${qs ? `?${qs}` : ''}`);
      _cachedProductPath = path;
      const d = res.raw?.data || res.data || {};
      const list = Array.isArray(d) ? d : (d.products || d.list || []);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      if (err.statusCode && err.statusCode !== 404) {
        console.warn(`[vtu] products ${path}:`, err.rawMessage || err.message);
      }
    }
  }
  return [];
}

export const fetchProducts = listProducts;

export async function listServices() {
  try {
    const res = await request('GET', '/list-services');
    const d = res.raw?.data || res.data || {};
    const list = Array.isArray(d) ? d : (d.services || d.list || []);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export async function listProviders(service = 'data') {
  try {
    const res = await request('GET', `/list-providers?service=${encodeURIComponent(service)}`);
    const d = res.raw?.data || res.data || {};
    const list = Array.isArray(d) ? d : (d.providers || d.list || []);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/* ============================================================
   AIRTIME  (unchanged — working)
   ============================================================ */
const AIRTIME_FALLBACKS = {
  mtn:    ['mtn-airtime', 'mtn'],
  airtel: ['airtel-airtime', 'airtel'],
  glo:    ['glo-airtime', 'glo', 'globacom-airtime', 'glo-mobile'],
  t2:     ['t2-airtime', 't2'],
};

export async function buyAirtime({ network, product_name, phone, customer_id, amount, reference }) {
  const net = String(network || '').toLowerCase();

  const primary = product_name || `${net}-airtime`;
  const fallbacks = AIRTIME_FALLBACKS[net] || [primary];
  const toTry = [primary, ...fallbacks.filter(p => p !== primary)];

  let lastErr;
  for (const name of toTry) {
    try {
      const result = await request('POST', '/purchase', {
        customer_id: String(customer_id || phone || ''),
        product_name: String(name),
        amount: Number(amount),
        reference: String(reference),
      });
      result.product_used = name;
      return result;
    } catch (err) {
      lastErr = err;

      const raw = String(err.rawMessage || err.message || '').toLowerCase();
      const isProductIssue = raw.includes('product') ||
                             raw.includes('not found') ||
                             raw.includes('invalid') ||
                             raw.includes('unknown');

      if (isProductIssue && toTry.indexOf(name) < toTry.length - 1) {
        console.warn(`[vtu] airtime product "${name}" rejected — trying next`);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* ============================================================
   DATA  (unchanged — working)
   ============================================================ */
export async function buyData({ planId, product_name, phone, customer_id, reference, amount, quantity }) {
  const body = {
    customer_id: String(customer_id || phone || ''),
    product_name: String(planId || product_name || ''),
    reference: String(reference),
  };
  if (amount   != null) body.amount   = Number(amount);
  if (quantity)         body.quantity = String(quantity);

  return request('POST', '/purchase', body);
}

/* ============================================================
   STATUS CHECKS  (FIXED — no silent swallowing)
   ============================================================ */
const STATUS_PATHS = [
  (ref) => `/transactions/${encodeURIComponent(ref)}`,
  (ref) => `/transaction/${encodeURIComponent(ref)}`,
  (ref) => `/purchases/${encodeURIComponent(ref)}`,
  (ref) => `/purchase/${encodeURIComponent(ref)}`,
  (ref) => `/status/${encodeURIComponent(ref)}`,
];

let _cachedStatusPath = null;

export async function checkTransactionStatus(reference) {
  if (!reference) throw new Error('reference required');

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

      // 404 = wrong path → try next path
      if (err.statusCode === 404) continue;

      // Provider returned a body (even on 4xx) → that body IS the answer.
      // DataShop often returns 200 with {status:false} for failed txns,
      // or 400 with the failure reason. Return it so the caller can normalize.
      if (err.providerResponse && typeof err.providerResponse === 'object') {
        const d = err.providerResponse.data;
        if (Array.isArray(d) && d.length) {
          return { ...err.providerResponse, data: d[0] };
        }
        return err.providerResponse;
      }

      // Network / 5xx with no body → cannot determine → bubble up (caller retries)
      throw err;
    }

    const d = res.raw?.data;
    if (Array.isArray(d) && d.length) {
      return { ...res.raw, data: d[0] };
    }
    return res.raw;
  }

  // Every path 404'd — transaction is unknown to provider
  const e = new Error('Transaction not found on DataShop');
  e.code = 'PROVIDER_NOT_FOUND';
  e.isUserSafe = true;
  e.rawMessage = lastErr?.rawMessage || 'not found';
  throw e;
}

export const checkAirtimeStatus   = checkTransactionStatus;
export const checkDataStatus      = checkTransactionStatus;
export const fetchTransaction     = checkTransactionStatus;
export const getTransactionStatus = checkTransactionStatus;

/* ============================================================
   VERIFY CUSTOMER  (unchanged — working)
   ============================================================ */
export async function verifyCustomer({ customer_id, phone, product_name }) {
  const res = await request('POST', '/verify-customer', {
    customer_id: String(customer_id || phone || ''),
    product_name: String(product_name || ''),
  });
  return res.data;
}

/* ============================================================
   REFERENCE  (unchanged — working)
   ============================================================ */
export function generateReference(prefix = 'SHAT') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${ts}-${rand}`.slice(0, 40);
}

/* ============================================================
   DEFAULT EXPORT
   ============================================================ */
export default {
  buyAirtime,
  buyData,
  listProducts,
  fetchProducts,
  listServices,
  listProviders,
  verifyCustomer,
  getDatashopBalance,
  getProviderBalance,
  checkTransactionStatus,
  checkAirtimeStatus,
  checkDataStatus,
  fetchTransaction,
  getTransactionStatus,
  normalizeProviderStatus,
  normalizeProviderError,
  generateReference,
};
