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
   ERROR NORMALIZER
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
   STATUS NORMALIZER
   ============================================================ */
export function normalizeProviderStatus(payload) {
  if (!payload) return 'failed';
  if (typeof payload !== 'object') return 'processing';

  const outer = payload;
  const inner = (outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data))
    ? outer.data
    : {};

  const candidates = [
    inner.transaction_status,
    inner.transactionStatus,
    inner.payment_status,
    inner.paymentStatus,
    inner.state,
    inner.status,
    inner.result,
    outer.transaction_status,
    outer.transactionStatus,
    outer.payment_status,
    outer.state,
    typeof outer.status === 'string' ? outer.status : null,
    outer.code,
    outer.result,
  ];

  const SUCCESS = ['success','successful','succeeded','completed','complete','delivered','approved','done','paid','processed','sent'];
  const FAILED  = ['fail','failed','failure','rejected','cancelled','canceled','declined','error','refunded','invalid','not successful','expired'];
  const PENDING = ['processing','pending','in_progress','in-progress','submitted','queued','initiated','awaiting','in progress','new'];

  for (const raw of candidates) {
    if (raw == null) continue;
    if (typeof raw === 'boolean') continue;
    const s = String(raw).toLowerCase().trim();
    if (!s) continue;

    if (FAILED.some((k) => s.includes(k))) return 'failed';
    if (SUCCESS.some((k) => s.includes(k))) return 'successful';
    if (PENDING.some((k) => s.includes(k))) return 'processing';
  }

  if (typeof outer.status === 'boolean') {
    return outer.status ? 'successful' : 'failed';
  }
  return 'processing';
}

/* ============================================================
   SHARED CALLER
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
   PROVIDER BALANCE
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
   PRODUCTS
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
   AIRTIME PRODUCT NAMES — T2 only, no 9mobile anywhere
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
   PURCHASE — DATA
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
   STATUS CHECKS
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

  for (const makePath of paths) {
    const path = makePath(reference);
    try {
      const res = await request('GET', path);
      _cachedStatusPath = makePath;

      const d = res.raw?.data;
      if (Array.isArray(d) && d.length) {
        return { ...res.raw, data: d[0] };
      }
      return res.raw;
    } catch (err) {
      if (err.statusCode === 404) continue;
      if (err.providerResponse && err.statusCode < 500) {
        return err.providerResponse;
      }
    }
  }
  throw new Error('Transaction not found on DataShop');
}

export const checkAirtimeStatus   = checkTransactionStatus;
export const checkDataStatus      = checkTransactionStatus;
export const fetchTransaction     = checkTransactionStatus;
export const getTransactionStatus = checkTransactionStatus;

/* ============================================================
   VERIFY CUSTOMER
   ============================================================ */
export async function verifyCustomer({ customer_id, phone, product_name }) {
  const res = await request('POST', '/verify-customer', {
    customer_id: String(customer_id || phone || ''),
    product_name: String(product_name || ''),
  });
  return res.data;
}

/* ============================================================
   REFERENCE
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