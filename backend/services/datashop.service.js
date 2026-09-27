// services/datashop.service.js
// ============================================================
// DataShop Africa — API Service (v14 — definite vs ambiguous)
// ============================================================

import axios from 'axios';
import crypto from 'crypto';
import { env } from '../env/env.js';

const BASE_URL = env.VTU_API_BASE || 'https://app.datashop.africa/api/v2';
const API_KEY  = env.VTU_API_KEY  || '';

const DEBUG = String(env.DATASHOP_DEBUG || '').toLowerCase() === 'true' ||
              process.env.NODE_ENV !== 'production';

if (API_KEY) {
  console.log(`[datashop] Base URL: ${BASE_URL}`);
  console.log(`[datashop] API Key:  ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  if (env.DATASHOP_WEBHOOK_SECRET) {
    console.log(`[datashop] Webhook secret: ${String(env.DATASHOP_WEBHOOK_SECRET).slice(0, 10)}...`);
  } else {
    console.warn('[datashop] ⚠ DATASHOP_WEBHOOK_SECRET is missing — webhook signature verification disabled');
  }
} else {
  console.warn('[datashop] ⚠ VTU_API_KEY is missing');
}

const TIMEOUTS = { purchase: 30000, status: 15000, list: 60000, default: 30000 };

const client = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUTS.default,
  headers: {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
  },
});

function debug(...args) { if (DEBUG) console.log(...args); }

/* ============================================================
   USER-SAFE ERROR NORMALIZER
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
      msg.includes('invalid number') || msg.includes('phone number is invalid')) {
    return 'The phone number entered is invalid for this network.';
  }
  if (msg.includes('out of stock') || msg.includes('unavailable') ||
      msg.includes('not available') || msg.includes('product not found') ||
      msg.includes('plan not found') || msg.includes('invalid product')) {
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
   ENDPOINT CACHE
   ============================================================ */
const resolvedPaths = {
  services: null, providers: null, products: null, status: null, balance: null,
};

const CANDIDATES = {
  services:  ['/list-services', '/services', '/get-services'],
  providers: ['/list-providers', '/providers', '/get-providers'],
  products:  ['/list-products', '/products', '/get-products'],
};

const BALANCE_CANDIDATES = [
  '/balance', '/wallet/balance', '/user/balance', '/account/balance',
  '/me', '/user', '/profile', '/dashboard',
  '/v2/balance', '/v2/wallet/balance', '/v2/me',
  '/api/balance', '/api/wallet', '/api/me',
  '/get-balance', '/check-balance', '/wallet', '/account',
  '/user/me', '/auth/me',
];

/* ============================================================
   ERROR CLASSIFIER — definite vs ambiguous
   ============================================================ */
function wrapError(err, context = {}) {
  const status = err.response?.status;
  const raw = err.response?.data?.message
           || err.response?.data?.error
           || err.message
           || 'Unknown error';

  const wrapped = new Error(normalizeProviderError(raw));
  wrapped.code = 'PROVIDER_FAILED';
  wrapped.isUserSafe = true;
  wrapped.rawMessage = raw;
  wrapped.providerResponse = err.response?.data;
  wrapped.statusCode = status;
  wrapped.context = context;

  const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
  const isNetworkError = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']
    .includes(err.code);
  const isServer5xx = typeof status === 'number' && status >= 500;

  const lower = String(raw).toLowerCase();
  const UNAVAILABLE_PATTERNS = [
    'not available', 'temporarily unavailable', 'unavailable at the moment',
    'select another product', 'out of stock', 'no longer available',
    'sold out', 'product not found', 'plan not found', 'invalid product',
    'invalid phone', 'invalid customer', 'invalid number',
    'wrong number', 'duplicate', 'invalid api key', 'unauthorized',
  ];
  const isDefiniteProviderRejection = UNAVAILABLE_PATTERNS.some((p) => lower.includes(p));

  wrapped.isTimeout = isTimeout;
  wrapped.isNetworkError = isNetworkError;
  wrapped.isServer5xx = isServer5xx;
  wrapped.isDefiniteProviderRejection = isDefiniteProviderRejection;
  wrapped.unavailable = isDefiniteProviderRejection;

  if (isDefiniteProviderRejection) {
    wrapped.mayHaveSucceeded = false;
    wrapped.isDefiniteFailure = true;
  } else if (isTimeout || isNetworkError || isServer5xx) {
    wrapped.mayHaveSucceeded = true;
    wrapped.isDefiniteFailure = false;
  } else if (typeof status === 'number' && status >= 400 && status < 500) {
    wrapped.mayHaveSucceeded = false;
    wrapped.isDefiniteFailure = true;
  } else {
    wrapped.mayHaveSucceeded = false;
    wrapped.isDefiniteFailure = true;
  }

  return wrapped;
}

/* ============================================================
   REQUEST HELPERS
   ============================================================ */
async function smartGet(key, params = {}) {
  const cached = resolvedPaths[key];
  const paths  = cached ? [cached] : CANDIDATES[key];
  let lastErr;
  for (const path of paths) {
    try {
      const res = await client.get(path, { params, timeout: TIMEOUTS.list });
      resolvedPaths[key] = path;
      console.log(`[datashop] ✅ ${key} → ${path} (200)`);
      return res;
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404) throw wrapError(err, { key, path });
      lastErr = err;
    }
  }
  throw new Error(`DataShop ${key} endpoint not found.`);
}

async function smartPost(path, body, opts = {}) {
  try {
    return await client.post(path, body, { timeout: opts.timeout || TIMEOUTS.purchase });
  } catch (err) {
    throw wrapError(err, { path });
  }
}

/* ============================================================
   PURCHASES
   ============================================================ */
export async function buyAirtime({ customer_id, product_name, amount, reference }) {
  if (!API_KEY) {
    return { ok: false, status: 'failed', mayHaveSucceeded: false,
             data: null, error: 'Payment provider not configured',
             rawError: 'no API key', isTimeout: false };
  }
  const body = { customer_id, product_name, amount: Number(amount), reference };
  console.log(`\n[datashop.buyAirtime] ═══════════════════════════════════`);
  console.log(`[datashop.buyAirtime] → ${BASE_URL}/purchase`);
  console.log(`[datashop.buyAirtime] → body:`, JSON.stringify(body));

  try {
    const res = await smartPost('/purchase', body);
    console.log(`[datashop.buyAirtime] ← HTTP ${res.status}`);
    console.log(`[datashop.buyAirtime] ← response:`, JSON.stringify(res.data).slice(0, 800));
    console.log(`[datashop.buyAirtime] ═══════════════════════════════════\n`);
    return { ok: true, status: 'submitted', mayHaveSucceeded: true,
             data: res.data, error: null, rawError: null, isTimeout: false };
  } catch (err) {
    console.error(`[datashop.buyAirtime] ← ERROR`);
    console.error(`[datashop.buyAirtime] ← HTTP status:`, err.statusCode);
    console.error(`[datashop.buyAirtime] ← message:`, err.rawMessage);
    console.error(`[datashop.buyAirtime] ← raw response:`, JSON.stringify(err.providerResponse || {}).slice(0, 800));
    console.error(`[datashop.buyAirtime] ═══════════════════════════════════\n`);
    return {
      ok: false,
      status: err.mayHaveSucceeded ? 'unknown' : 'failed',
      mayHaveSucceeded: !!err.mayHaveSucceeded,
      data: err.providerResponse || null,
      error: err.message,
      rawError: err.rawMessage || err.message,
      isTimeout: !!err.isTimeout,
      unavailable: !!err.unavailable,
    };
  }
}

export async function buyData({ customer_id, product_name, amount, quantity, reference }) {
  if (!API_KEY) {
    return { ok: false, status: 'failed', mayHaveSucceeded: false,
             data: null, error: 'Payment provider not configured',
             rawError: 'no API key', isTimeout: false };
  }
  const body = { customer_id, product_name, reference };
  if (amount   != null) body.amount   = Number(amount);
  if (quantity)         body.quantity = quantity;

  console.log(`\n[datashop.buyData] ════════════════════════════════════════`);
  console.log(`[datashop.buyData] → ${BASE_URL}/purchase`);
  console.log(`[datashop.buyData] → body:`, JSON.stringify(body));

  try {
    const res = await smartPost('/purchase', body);
    console.log(`[datashop.buyData] ← HTTP ${res.status}`);
    console.log(`[datashop.buyData] ← response:`, JSON.stringify(res.data).slice(0, 800));
    console.log(`[datashop.buyData] ════════════════════════════════════════\n`);
    return { ok: true, status: 'submitted', mayHaveSucceeded: true,
             data: res.data, error: null, rawError: null, isTimeout: false };
  } catch (err) {
    console.error(`[datashop.buyData] ← ERROR`);
    console.error(`[datashop.buyData] ← HTTP status:`, err.statusCode);
    console.error(`[datashop.buyData] ← message:`, err.rawMessage);
    console.error(`[datashop.buyData] ← raw response:`, JSON.stringify(err.providerResponse || {}).slice(0, 800));
    console.error(`[datashop.buyData] ════════════════════════════════════════\n`);
    return {
      ok: false,
      status: err.mayHaveSucceeded ? 'unknown' : 'failed',
      mayHaveSucceeded: !!err.mayHaveSucceeded,
      data: err.providerResponse || null,
      error: err.message,
      rawError: err.rawMessage || err.message,
      isTimeout: !!err.isTimeout,
      unavailable: !!err.unavailable,
    };
  }
}

/* ============================================================
   LIST ENDPOINTS
   ============================================================ */
export async function listServices() {
  const res = await smartGet('services');
  const d = res.data?.data || res.data || {};
  const list = Array.isArray(d) ? d : (d.services || d.list || []);
  return Array.isArray(list) ? list : [];
}

export async function listProviders(service = 'data') {
  const res = await smartGet('providers', service ? { service } : {});
  const d = res.data?.data || res.data || {};
  const list = Array.isArray(d) ? d : (d.providers || d.list || []);
  return Array.isArray(list) ? list : [];
}

export async function listProducts({ service = 'data', provider, network } = {}) {
  const params = {};
  if (service)  params.service  = service;
  if (provider) params.provider = provider;
  if (network)  params.network  = network;
  const res = await smartGet('products', params);
  const d = res.data?.data || res.data || {};
  const list = Array.isArray(d) ? d : (d.products || d.list || []);
  return Array.isArray(list) ? list : [];
}

export async function getProduct(productName) {
  if (!productName) throw new Error('productName is required');
  try {
    const res = await client.get(`/products/${encodeURIComponent(productName)}`, { timeout: TIMEOUTS.status });
    return res.data?.data || res.data || null;
  } catch {
    const res = await client.get('/get-product', { params: { product_name: productName }, timeout: TIMEOUTS.status });
    return res.data?.data || res.data || null;
  }
}

export async function verifyCustomer({ customer_id, product_name }) {
  const res = await smartPost('/verify-customer', { customer_id, product_name }, { timeout: TIMEOUTS.status });
  return res.data?.data || res.data || {};
}

/* ============================================================
   LEGACY REF DETECTION
   ============================================================ */
function isLegacyReference(reference) {
  const ref = String(reference || '');
  if (/^shatova-(data|airtime)-/i.test(ref)) return false;
  return true;
}

/* ============================================================
   TRANSACTION STATUS
   ============================================================ */
export async function checkTransactionStatus(reference) {
  if (!reference) throw new Error('Reference is required');
  if (isLegacyReference(reference)) {
    debug(`[datashop] skip legacy ref ${reference}`);
    const err = new Error('Transaction not found on DataShop');
    err.code = 'LEGACY_REFERENCE';
    err.silent = true;
    throw err;
  }

  if (resolvedPaths.status) {
    const tpl = resolvedPaths.status;
    try {
      let res;
      if (tpl.includes(':ref')) {
        const path = tpl.replace(':ref', encodeURIComponent(reference));
        res = await client.get(path, { timeout: TIMEOUTS.status });
      } else {
        res = await client.get(tpl, { params: { reference }, timeout: TIMEOUTS.status });
      }
      debug(`[datashop] ✅ status ${reference} via cached ${tpl}`);
      return unwrapArray(res.data);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        debug(`[datashop] cached status 404 → clearing`);
        resolvedPaths.status = null;
      }
    }
  }

  const candidates = [
    { path: `/transactions/${encodeURIComponent(reference)}`, isPath: true },
    { path: `/transaction/${encodeURIComponent(reference)}`,  isPath: true },
    { path: `/purchases/${encodeURIComponent(reference)}`,    isPath: true },
    { path: `/purchase/${encodeURIComponent(reference)}`,     isPath: true },
    { path: `/status/${encodeURIComponent(reference)}`,       isPath: true },
    { path: `/transactions`,       params: { reference } },
    { path: `/transaction`,        params: { reference } },
    { path: `/get-transaction`,    params: { reference } },
    { path: `/transaction-status`, params: { reference } },
    { path: `/status`,             params: { reference } },
    { path: `/purchase/status`,    params: { reference } },
    { path: `/purchases`,          params: { reference } },
  ];

  let lastErr;
  for (const c of candidates) {
    try {
      const res = c.isPath
        ? await client.get(c.path, { timeout: TIMEOUTS.status })
        : await client.get(c.path, { params: c.params, timeout: TIMEOUTS.status });
      resolvedPaths.status = c.isPath
        ? c.path.replace(encodeURIComponent(reference), ':ref')
        : c.path;
      const unwrapped = unwrapArray(res.data);
      debug(`[datashop] ✅ status ${reference} via ${c.path}`);
      return unwrapped;
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404) {
        if (err.response?.data && status < 500) return err.response.data;
      }
      lastErr = err;
    }
  }

  const err = new Error('Transaction not found on DataShop');
  err.code = 'NOT_FOUND';
  throw err;
}

export const checkAirtimeStatus   = checkTransactionStatus;
export const checkDataStatus      = checkTransactionStatus;
export const fetchTransaction     = checkTransactionStatus;
export const getTransactionStatus = checkTransactionStatus;

function unwrapArray(body) {
  if (Array.isArray(body?.data) && body.data.length) {
    return { ...body, data: body.data[0] };
  }
  return body;
}

/* ============================================================
   STATUS NORMALIZER
   ============================================================ */
export function normalizeProviderStatus(providerResponse) {
  if (!providerResponse) return 'processing';
  if (typeof providerResponse !== 'object') return 'processing';

  const outer = providerResponse;
  const inner = (outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data))
    ? outer.data : {};

  const candidates = [
    inner.transaction_status, inner.transactionStatus,
    inner.payment_status, inner.paymentStatus,
    inner.state, inner.status, inner.result,
    outer.transaction_status, outer.transactionStatus,
    outer.payment_status, outer.state,
    typeof outer.status === 'string' ? outer.status : null,
    outer.code, outer.result,
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
  if (typeof outer.status === 'boolean') return outer.status ? 'successful' : 'failed';
  return 'processing';
}

export function generateReference(prefix = 'shatova-data') {
  const ts   = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`.slice(0, 40);
}

/* ============================================================
   POLL HELPER
   ============================================================ */
export async function pollTransactionUntilResolved(reference, options = {}) {
  const maxMs    = options.maxMs    || 60000;
  const interval = options.interval || 3000;
  const startedAt = Date.now();
  let polls = 0;
  let lastDetails = null;

  while (Date.now() - startedAt < maxMs) {
    polls++;
    try {
      const details = await getTransactionDetails(reference);
      lastDetails = details;
      if (details && details.status && details.status !== 'processing') {
        return { status: details.status, details, polls, elapsed: Date.now() - startedAt };
      }
    } catch (err) {
      if (err.code === 'LEGACY_REFERENCE' || err.code === 'NOT_FOUND') {
        return { status: 'not_found', details: null, polls, elapsed: Date.now() - startedAt };
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { status: 'timeout', details: lastDetails, polls, elapsed: Date.now() - startedAt };
}

/* ============================================================
   BALANCE
   ============================================================ */
export async function getDatashopBalance() {
  if (resolvedPaths.balance) {
    try {
      const res = await client.get(resolvedPaths.balance, { timeout: TIMEOUTS.status });
      const b = extractBalance(res.data);
      if (b != null) return b;
    } catch (err) {
      if (err.response?.status === 404) resolvedPaths.balance = null;
    }
  }
  for (const path of BALANCE_CANDIDATES) {
    try {
      const res = await client.get(path, { timeout: TIMEOUTS.status });
      const b = extractBalance(res.data);
      if (b != null) {
        resolvedPaths.balance = path;
        console.log(`[datashop] ✅ balance → ${path} = ₦${b}`);
        return b;
      }
    } catch (_) {}
  }
  console.warn('[datashop] balance: no working endpoint found');
  return null;
}

function extractBalance(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.balance, body.wallet_balance, body.walletBalance,
    body.available_balance, body.availableBalance, body.current_balance,
    body.data?.balance, body.data?.wallet_balance, body.data?.available_balance,
    body.data?.wallet?.balance, body.wallet?.balance,
    body.user?.balance, body.user?.wallet?.balance,
    body.data?.user?.balance, body.data?.user?.wallet?.balance,
    body.account?.balance, body.data?.account?.balance,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(String(c).replace(/[^0-9.-]/g, ''));
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return null;
}

/* ============================================================
   WEBHOOK
   ============================================================ */
export function verifyWebhookSignature(rawBody, header, secret = null) {
  const key = secret || env.DATASHOP_WEBHOOK_SECRET || process.env.DATASHOP_WEBHOOK_SECRET || '';
  if (!key) { console.warn('[datashop.webhook] ⚠ no signing secret'); return false; }
  if (!header) { console.warn('[datashop.webhook] ⚠ no signature header'); return false; }
  const provided = String(header).replace(/^sha256=/i, '').trim();
  if (!provided) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export function normalizeWebhookPayload(body) {
  const b = body || {};
  const event = String(b.event || b.type || b.event_type || b.eventType || b.action || 'unknown').toLowerCase();
  const data = b.data || b.payload || b.transaction || b;
  const reference = String(
    data.reference || data.tx_ref || data.transaction_reference || data.provider_reference || b.reference || ''
  ).trim();
  const status = String(
    data.transaction_status || data.transactionStatus || data.status || b.status || ''
  ).toLowerCase();
  const rawAmount = data.paid_amount ?? data.paidAmount ?? data.amount ?? data.value ?? b.amount ?? 0;
  const paidAmount = Number(String(rawAmount).replace(/[^0-9.-]/g, '')) || 0;
  const remark = String(data.remark || data.message || data.description || b.remark || b.message || '').trim();
  const customerId = String(data.customer_id || data.customerId || data.phone || '').trim();
  const productName = String(data.product_name || data.productName || data.plan_id || '').trim();
  const provider = String(data.provider || data.network || '').trim();
  return { event, reference, status, paidAmount, remark, customerId, productName, provider, raw: b };
}

export async function getTransactionDetails(reference) {
  if (!reference) throw new Error('reference is required');
  let response;
  try { response = await checkTransactionStatus(reference); }
  catch (err) {
    if (err.code === 'LEGACY_REFERENCE' || err.code === 'NOT_FOUND') return null;
    throw err;
  }
  if (!response) return null;
  const payload = response.data || response;
  return {
    reference: String(payload.reference || reference),
    status:    normalizeProviderStatus(response),
    rawStatus: String(payload.transaction_status || payload.status || '').toLowerCase(),
    amount:    Number(payload.paid_amount ?? payload.amount ?? 0) || 0,
    quantity:  String(payload.quantity || ''),
    provider:  String(payload.provider || ''),
    customerId: String(payload.customer_id || ''),
    productName: String(payload.product_name || ''),
    remark:    String(payload.remark || payload.message || ''),
    createdAt: payload.created_at || null,
    raw:       payload,
  };
}

/* ============================================================
   PRICING CONSOLE
   ============================================================ */
const PRICE_SERVICES = ['data', 'airtime', 'tv', 'electricity', 'exam'];

export function normalizePricingRow(p, service) {
  const code =
    p.product_name || p.product_code || p.code || p.plan_id ||
    p.id || p.slug || p.name || '';
  const name = p.name || p.title || p.product_name || code;
  const network = (
    p.network || p.provider || p.operator ||
    p.service_provider || p.telco || ''
  ).toString().toUpperCase();
  const cost = Number(
    p.amount ?? p.price ?? p.cost ?? p.user_amount ??
    p.plan_amount ?? p.value ?? p.amount_payable ?? 0
  ) || 0;
  return {
    category:    String(service || p.service || p.category || 'data').toLowerCase(),
    code:        String(code),
    name:        String(name),
    network,
    validity:    p.validity || p.duration || p.plan_type || '',
    cost_price:  cost,
    description: p.description || p.desc || p.remark || '',
    _raw_keys:   Object.keys(p || {}).slice(0, 25),
  };
}

export async function fetchAllProductsForPricing() {
  const products = [];
  const errors   = [];
  const attempts = [
    ...PRICE_SERVICES.map((s) => ({ service: s, label: s })),
    { service: null, label: 'all' },
  ];
  for (const a of attempts) {
    try {
      const list = a.service ? await listProducts({ service: a.service }) : await listProducts({});
      const arr = Array.isArray(list) ? list : [];
      console.log(`[pricing] service=${a.label} → ${arr.length} raw item(s)`);
      if (arr[0]) console.log(`[pricing] ${a.label} sample keys:`, Object.keys(arr[0]).join(', '));
      arr.forEach((p) => products.push(normalizePricingRow(p, a.service || p.service || 'data')));
    } catch (err) {
      console.warn(`[pricing] service=${a.label} failed:`, err.message);
      errors.push({ category: a.label, error: err.message });
    }
  }
  const seen = new Set();
  const unique = products.filter((p) => {
    const key = (p.code && String(p.code)) || (p.name && String(p.name));
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[pricing] raw=${products.length} unique=${unique.length} errors=${errors.length}`);
  return { products: unique, errors };
}

export default {
  buyAirtime, buyData, listServices, listProviders, listProducts, getProduct,
  verifyCustomer, checkTransactionStatus, checkAirtimeStatus, checkDataStatus,
  fetchTransaction, getTransactionStatus, normalizeProviderStatus,
  normalizeProviderError, generateReference, getDatashopBalance,
  verifyWebhookSignature, normalizeWebhookPayload, getTransactionDetails,
  fetchAllProductsForPricing, normalizePricingRow, pollTransactionUntilResolved,
};