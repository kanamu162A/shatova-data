// frontend/js/data.js
// ============================================================
// Shatova — Data Purchase Flow (v16 — timeout-safe UX)
//   ⭐ Slim phone dropdown (numbers only, no logos)
//   ⭐ Auto-prepend 0, +234 → 0, 234 → 0
//   ⭐ Purchase modal + smart polling
//   ⭐ Handles: success · processing (ambiguous) · failed
//   ⭐ Fast auto-return home on final status
// ============================================================

import { mountCategoryHeader } from './category-header.js';
import { FilterComponent }     from './filter.js';

const API_BASE = window.API_BASE;

/* ── Timing budget ──
   Poll fast for the first 20s, then slower. Keep the modal open
   the whole time. Auto-return home only after a FINAL status. */
const POLL_FAST_INTERVAL_MS  = 2500;   // first 8 polls (~20s)
const POLL_SLOW_INTERVAL_MS  = 5000;   // after that
const POLL_FAST_LIMIT        = 8;
const POLL_MAX_ATTEMPTS      = 40;     // 8×2.5s + 32×5s ≈ 180s

/* Auto-return home (only fires AFTER final status) */
const RETURN_SUCCESS_MS = 2500;
const RETURN_FAILED_MS  = 4500;
const RETURN_REFUND_MS  = 4000;

/* ============================================================
   AUTH
   ============================================================ */
function getToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}
function authHeaders(extra = {}) {
  const t = getToken();
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...extra,
  };
}
function redirectToLogin() { window.location.href = '/login.html'; }

/* ============================================================
   STATE
   ============================================================ */
const state = {
  networks: [],
  categories: [],
  bundles: [],
  visibleBundles: [],
  activeNetwork: 'all',
  activeProvider: null,
  activeCategory: null,
  filterValue: 'all',
  selectedBundle: null,
  mode: 'single',
  phone: '',
  paymentMethod: 'wallet',
  walletBalance: 0,
  currentReference: null,
  recentRecipients: [],
  lastPurchase: null,
};

let filterInstance = null;

/* ============================================================
   DOM
   ============================================================ */
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const stepCategories = $('#step-categories');
const stepBundles    = $('#step-bundles');
const stepCheckout   = $('#step-checkout');
const stepPay        = $('#step-pay');

const categoryList = $('#categoryList');
const pageHeadSlot = $('#pageHeadSlot');
const filterMount  = $('#filterMount');

const bundlesTitle = $('#bundlesTitle');
const bundlesSub   = $('#bundlesSub');
const bundlesList  = $('#bundlesList');

const selectedBundleCard = $('#selectedBundleCard');
const payBundleCard      = $('#payBundleCard');
const payPhone           = $('#payPhone');
const walletBalanceEl    = $('#walletBalance');
const totalAmountEl      = $('#totalAmount');

const phoneInput     = $('#phoneInput');
const phoneError     = $('#phoneError');
const continueBtn    = $('#continueBtn');
const payNowBtn      = $('#payNowBtn');
const pickContactBtn = $('#pickContact');

const phoneDropdown     = $('#phoneDropdown');
const phoneDropdownList = $('#phoneDropdownList');
const phoneInputWrap    = phoneInput?.parentElement;

const balanceWarning     = $('#balanceWarning');
const balanceWarningText = $('#balanceWarningText');
const fundWalletBtn      = $('#fundWalletBtn');

const purchaseModal = $('#purchaseModal');
const pmClose       = $('#pmClose');
const pmDone        = $('#pmDone');
const pmRefresh     = $('#pmRefresh');
const pmCopy        = $('#pmCopy');
const pmShare       = $('#pmShare');
const pmPrint       = $('#pmPrint');
const pmHero        = $('#pmHero');
const pmHeroTitle   = $('#pmHeroTitle');
const pmHeroSub     = $('#pmHeroSub');
const pmProduct     = $('#pmProduct');
const pmAmount      = $('#pmAmount');
const pmRemark      = $('#pmRemark');
const pmRecipient   = $('#pmRecipient');
const pmReference   = $('#pmReference');
const pmExtra       = $('#pmExtra');
const pmTracker     = $('#pmTracker');

let lastPurchase      = null;
let pollTimer         = null;
let autoReturnTimer   = null;
let countdownInterval = null;

/* ============================================================
   UTILITIES
   ============================================================ */
function showStep(step) {
  [stepCategories, stepBundles, stepCheckout, stepPay]
    .forEach((s) => s && s.classList.add('hidden'));
  if (step) step.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function networkClass(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('mtn'))    return 'mtn';
  if (k.includes('airtel')) return 'airtel';
  if (k.includes('glo'))    return 'glo';
  if (k.includes('t2'))     return 't2';
  if (k.includes('9mobile') || k.includes('etisalat')) return 't2';
  if (k.includes('wallet')) return 'wallet';
  return 'mtn';
}

function networkShort(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('mtn'))    return 'MTN';
  if (k.includes('airtel')) return 'AIRTEL';
  if (k.includes('glo'))    return 'GLO';
  if (k.includes('t2'))     return 'T2';
  if (k.includes('9mobile') || k.includes('etisalat')) return '9MOBILE';
  if (k.includes('wallet')) return 'WALLET';
  return String(key).toUpperCase().slice(0, 6);
}

function networkDisplay(key) {
  const k = String(key || '').toLowerCase();
  if (k === 't2' || k === 'etisalat') return '9mobile';
  if (k === 'mtn')    return 'MTN';
  if (k === 'airtel') return 'Airtel';
  if (k === 'glo')    return 'Glo';
  if (k === '9mobile') return '9mobile';
  return k.toUpperCase();
}

function spinButton(btn, label = 'Loading…') {
  if (!btn) return () => {};
  const originalHTML = btn.innerHTML;
  const originalDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-inline"></span> ${label}`;
  return function restore() {
    btn.disabled = originalDisabled;
    btn.innerHTML = originalHTML;
  };
}

/* ============================================================
   SMART PHONE NORMALIZER
   ============================================================ */
function smartNormalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('234') && p.length > 10) p = '0' + p.slice(3);
  if (p.length > 0 && /^[789]/.test(p)) p = '0' + p;
  return p.slice(0, 11);
}

function normalizeNgPhone(raw) {
  return smartNormalizePhone(raw);
}

/* ============================================================
   PHONE NETWORK DETECTION
   ============================================================ */
const NG_PREFIXES = {
  mtn:     ['0803','0806','0703','0706','0813','0816','0810','0814','0903','0906','0913','0916','0704'],
  airtel:  ['0802','0808','0708','0812','0701','0902','0901','0907','0912','0911'],
  glo:     ['0805','0807','0705','0815','0811','0905','0915'],
  '9mobile': ['0809','0817','0818','0908','0909'],
};
const MTN_5DIGIT = ['07025', '07026'];

function detectNetworkFromPrefix(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 4) return null;
  const p4 = p.slice(0, 4);
  const p5 = p.slice(0, 5);
  if (MTN_5DIGIT.includes(p5)) return 'mtn';
  for (const [network, prefixes] of Object.entries(NG_PREFIXES)) {
    if (prefixes.includes(p4)) return network;
  }
  return null;
}

function phoneMatchesNetwork(phone, networkKey) {
  if (!phone || !networkKey) return true;
  const detected = detectNetworkFromPrefix(phone);
  if (!detected) return true;
  const n = String(networkKey).toLowerCase();
  if (detected === n) return true;
  if ((detected === '9mobile' && n === 't2') || (detected === 't2' && n === '9mobile')) return true;
  return false;
}

/* ============================================================
   PHONE DROPDOWN — slim, numbers only
   ============================================================ */
function renderDropdownItem(phone, matchedPrefix) {
  let highlighted;
  if (matchedPrefix && phone.startsWith(matchedPrefix)) {
    const rest = phone.slice(matchedPrefix.length);
    highlighted =
      `<span class="pd-match">${escapeHtml(matchedPrefix)}</span>` +
      `<span class="pd-rest">${escapeHtml(rest)}</span>`;
  } else {
    highlighted = escapeHtml(phone);
  }

  return `
    <button type="button" class="phone-dropdown-item" data-phone="${escapeHtml(phone)}">
      ${highlighted}
    </button>`;
}

function updatePhoneSuggestions() {
  if (!phoneDropdown || !phoneDropdownList) return;

  const typed = String(phoneInput?.value || '').replace(/\D/g, '');
  const activeNetwork = state.activeProvider || state.activeNetwork;

  let candidates = (state.recentRecipients || [])
    .filter((r) => phoneMatchesNetwork(r.phone, activeNetwork));

  if (typed.length > 0) {
    candidates = candidates.filter((r) => String(r.phone).startsWith(typed));
  }

  candidates.sort((a, b) => {
    const aMatch = a.phone.startsWith(typed);
    const bMatch = b.phone.startsWith(typed);
    if (aMatch !== bMatch) return aMatch ? -1 : 1;
    const aT = new Date(a.last_used || a.created_at || 0).getTime();
    const bT = new Date(b.last_used || b.created_at || 0).getTime();
    return bT - aT;
  });

  const matches = candidates.slice(0, 6);

  if (!matches.length) { hidePhoneDropdown(); return; }

  phoneDropdownList.innerHTML = matches
    .map((r) => renderDropdownItem(r.phone, typed))
    .join('');

  phoneDropdownList.querySelectorAll('.phone-dropdown-item').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const phone = btn.dataset.phone;
      phoneInput.value = phone;
      phoneInput.classList.add('filled');
      setTimeout(() => phoneInput.classList.remove('filled'), 700);
      clearPhoneError();
      hidePhoneDropdown();
      continueBtn?.focus();
    });
  });

  showPhoneDropdown();
}

function showPhoneDropdown() {
  if (!phoneDropdown) return;
  phoneDropdown.classList.remove('hidden');
  phoneInputWrap?.classList.add('has-dropdown');
}

function hidePhoneDropdown() {
  if (!phoneDropdown) return;
  phoneDropdown.classList.add('hidden');
  phoneInputWrap?.classList.remove('has-dropdown');
}

function clearPhoneError() {
  phoneInput?.classList.remove('error');
  phoneError?.classList.remove('show');
}

async function fetchRecentRecipients() {
  try {
    const res = await fetch(`${API_BASE}/airtime/recent-recipients`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return json.data?.recipients || [];
  } catch { return []; }
}

/* ============================================================
   PROVIDER + CATEGORY ORDER
   ============================================================ */
const PROVIDER_ORDER = { mtn: 1, airtel: 2, glo: 3, t2: 4, '9mobile': 4 };
function providerWeight(key = '') {
  const k = String(key).toLowerCase().trim();
  if (k in PROVIDER_ORDER) return PROVIDER_ORDER[k];
  if (k.includes('mtn'))    return 1;
  if (k.includes('airtel')) return 2;
  if (k.includes('glo'))    return 3;
  if (k.includes('t2') || k.includes('9mobile') || k.includes('etisalat')) return 4;
  return 99;
}

const CATEGORY_PRIORITY = [
  { match: 'share',       weight: 1 },
  { match: 'mobile data', weight: 2 },
  { match: 'social',      weight: 3 },
  { match: 'sme',         weight: 4 },
  { match: 'gifting',     weight: 5 },
  { match: 'always on',   weight: 6 },
  { match: 'corporate',   weight: 7 },
];
function categoryWeight(name = '') {
  const n = String(name).toLowerCase().trim();
  for (const p of CATEGORY_PRIORITY) if (n.includes(p.match)) return p.weight;
  return 999;
}

function sortCategories(list = []) {
  return [...list].sort((a, b) => {
    const aAvail = (Number(a.available) || 0) > 0 ? 0 : 1;
    const bAvail = (Number(b.available) || 0) > 0 ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    const aP = providerWeight(a.provider), bP = providerWeight(b.provider);
    if (aP !== bP) return aP - bP;
    const aC = categoryWeight(a.category), bC = categoryWeight(b.category);
    if (aC !== bC) return aC - bC;
    return String(a.category).localeCompare(String(b.category));
  });
}

/* ============================================================
   STICKY
   ============================================================ */
function ensureAllSticky() {
  const heads = document.querySelectorAll(
    '#step-bundles > .page-head, #step-checkout > .page-head, #step-pay > .page-head'
  );
  if (!heads.length) return;

  const headerH = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-h')
  ) || 46;

  heads.forEach((head) => {
    if (head.dataset.stickyFixed === '1') return;
    if (head.offsetParent === null) return;

    const originalScroll = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll < 200) return;

    window.scrollTo(0, 200);
    const after = head.getBoundingClientRect().top;
    window.scrollTo(0, originalScroll);

    if (Math.abs(after - headerH) > 14) {
      const h = head.offsetHeight;
      const spacer = document.createElement('div');
      spacer.style.height = h + 'px';
      spacer.style.width  = '100%';
      spacer.setAttribute('data-sticky-spacer', '1');
      head.parentNode.insertBefore(spacer, head);

      head.style.position = 'fixed';
      head.style.top      = headerH + 'px';
      head.style.left     = '0';
      head.style.right    = '0';
      head.style.margin   = '0';
      head.style.zIndex   = '30';
      head.style.padding  = '10px 20px 10px';
      head.style.background = 'rgba(247, 249, 248, 0.92)';
      head.style.borderBottom = '1px solid rgba(0, 0, 0, 0.05)';

      if (
        document.body.classList.contains('dark') ||
        document.body.classList.contains('theme-dark') ||
        document.documentElement.dataset.theme === 'dark'
      ) {
        head.style.background = 'rgba(13, 15, 14, 0.92)';
        head.style.borderBottom = '1px solid rgba(255, 255, 255, 0.06)';
      }

      head.dataset.stickyFixed = '1';
    }
  });
}

window.addEventListener('resize', () => requestAnimationFrame(ensureAllSticky));

/* ============================================================
   API CALLS
   ============================================================ */
async function fetchNetworks() {
  const res = await fetch(`${API_BASE}/data/networks`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return []; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load networks');
  return json.data?.networks || [];
}

async function fetchCategories(networkKey = 'all') {
  const url = networkKey && networkKey !== 'all'
    ? `${API_BASE}/data/categories?network=${encodeURIComponent(networkKey)}`
    : `${API_BASE}/data/categories`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return []; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load categories');
  return json.data?.categories || [];
}

async function fetchBundles(provider, categoryName) {
  const res = await fetch(
    `${API_BASE}/data/bundles?network=${encodeURIComponent(provider)}`,
    { headers: authHeaders() }
  );
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return []; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load bundles');
  const all = json.data?.bundles || [];
  return categoryName
    ? all.filter((b) => (b.category || '').toLowerCase() === categoryName.toLowerCase())
    : all;
}

async function fetchMe() {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return json.data?.user || json.user || null;
}

async function fetchWalletBalance() {
  try {
    const res = await fetch(`${API_BASE}/wallet/balance`, { headers: authHeaders() });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    if (!json.success) return null;
    return Number(json.data?.balance ?? json.data?.wallet?.balance ?? 0);
  } catch { return null; }
}

/* ⭐ purchaseData now ALWAYS returns 200 for business outcomes.
   Only true network/4xx errors throw. */
async function purchaseData(planId, phone, mode, paymentMethod) {
  const res = await fetch(`${API_BASE}/data/purchase`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      plan_id:        planId,
      phone,
      mode,
      payment_method: paymentMethod,
    }),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.success) {
    const err = new Error(json.message || 'Purchase failed');
    err.code = json.code;
    err.data = json.data;
    throw err;
  }
  return json.data || json;
}

async function fetchDataStatus(reference) {
  try {
    const res = await fetch(
      `${API_BASE}/data/status?reference=${encodeURIComponent(reference)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    if (!json.success) return null;
    return json.data;
  } catch { return null; }
}

/* ============================================================
   FILTER
   ============================================================ */
function buildFilterOptions(bundles) {
  const counts = {};
  bundles.forEach((b) => {
    const label = String(b.validity || b.sub_category || '').trim();
    const key = label.toLowerCase() || 'other';
    counts[key] = counts[key] || { label, count: 0 };
    counts[key].count += 1;
  });
  const options = [{ value: 'all', label: 'All products', count: bundles.length }];
  Object.keys(counts).sort().forEach((k) => {
    options.push({ value: k, label: counts[k].label.toUpperCase(), count: counts[k].count });
  });
  return options;
}

function applyFilter(value) {
  state.filterValue = value;
  const all = state.bundles || [];
  state.visibleBundles = value === 'all'
    ? all
    : all.filter((b) => String(b.validity || b.sub_category || '').trim().toLowerCase() === value);
  renderBundles(state.visibleBundles);
}

function mountFilter(bundles) {
  if (!filterMount) return;
  const opts = buildFilterOptions(bundles);
  if (opts.length <= 1) { filterMount.innerHTML = ''; return; }
  if (!filterInstance) {
    filterInstance = new FilterComponent({
      mount: filterMount,
      title: 'Filter products',
      subtitle: 'Select one subcategory to narrow this product list.',
      options: opts,
      onChange: (value) => applyFilter(value),
    });
  } else {
    filterInstance.setOptions(opts);
    filterInstance.reset();
  }
  state.filterValue = filterInstance.getValue();
}

/* ============================================================
   NETWORK / CATEGORY / BUNDLE
   ============================================================ */
async function selectNetwork(key) {
  state.activeNetwork = key;
  const row = pageHeadSlot?.querySelector('.networks-row');
  row?.querySelectorAll('.network-chip').forEach((c) => c.classList.toggle('active', c.dataset.network === key));

  if (categoryList) {
    categoryList.innerHTML = `
      <div class="bundles-empty" style="padding: 32px 20px;">
        <span style="display:inline-flex;align-items:center;gap:8px;color:#0a4534;font-weight:600;">
          <span class="spinner-dark"></span> Loading categories…
        </span>
      </div>`;
  }

  try {
    const categories = await fetchCategories(key);
    state.categories = categories;
    renderCategories();
  } catch (err) {
    console.error('[data] categories:', err);
    if (categoryList) categoryList.innerHTML = `<div class="bundles-empty">Could not load categories</div>`;
  }

  if (state.recentRecipients.length && phoneInput?.value.length < 11) {
    updatePhoneSuggestions();
  }
}

function renderCategories() {
  if (!categoryList) return;
  if (!state.categories.length) {
    categoryList.innerHTML = `<div class="bundles-empty">No categories available</div>`;
    return;
  }
  const sorted = sortCategories(state.categories);
  state.categories = sorted;

  categoryList.innerHTML = sorted.map((c) => {
    const available = Number(c.available) || 0;
    const total     = Number(c.total) || 0;
    const isUnavailable = available === 0;
    const subText = isUnavailable ? 'Unavailable' : `${available} available${total > available ? ` of ${total}` : ''}`;

    return `
      <div class="category-card ${isUnavailable ? 'unavailable' : ''}"
           data-provider="${escapeHtml(c.provider)}" data-category="${escapeHtml(c.category)}">
        <div class="cat-logo ${networkClass(c.provider)}">${escapeHtml(networkShort(c.provider))}</div>
        <div class="cat-info">
          <div class="cat-name">${escapeHtml(c.category)}</div>
          <div class="cat-sub ${isUnavailable ? 'unavailable' : ''}">${escapeHtml(subText)}</div>
        </div>
        <div class="cat-arrow">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
          </svg>
        </div>
      </div>`;
  }).join('');

  categoryList.querySelectorAll('.category-card').forEach((card) => {
    if (card.classList.contains('unavailable')) {
      card.addEventListener('click', (e) => e.stopPropagation());
      return;
    }
    card.addEventListener('click', () => selectCategory(card.dataset.provider, card.dataset.category));
  });
}

async function selectCategory(provider, category) {
  state.activeProvider = provider;
  state.activeCategory = category;
  state.filterValue = 'all';

  if (bundlesTitle) bundlesTitle.textContent = category;
  if (bundlesSub)   bundlesSub.textContent = 'Loading…';
  if (filterMount)  filterMount.innerHTML = '';
  if (bundlesList) {
    bundlesList.innerHTML = `
      <div class="bundles-empty" style="padding: 32px 20px;">
        <span style="display:inline-flex;align-items:center;gap:8px;color:#0a4534;font-weight:600;">
          <span class="spinner-dark"></span> Loading bundles…
        </span>
      </div>`;
  }

  showStep(stepBundles);

  try {
    const bundles = await fetchBundles(provider, category);
    state.bundles = bundles;
    state.visibleBundles = bundles;
    if (bundlesSub) bundlesSub.textContent = `${bundles.length} product${bundles.length === 1 ? '' : 's'}`;
    mountFilter(bundles);
    renderBundles(bundles);
  } catch (err) {
    console.error('[data] bundles:', err);
    if (bundlesList) bundlesList.innerHTML = `<div class="bundles-empty">Could not load bundles</div>`;
    if (bundlesSub)  bundlesSub.textContent = '';
  }
}

function renderBundles(list) {
  if (!bundlesList) return;
  const bundles = Array.isArray(list) ? list : state.visibleBundles || [];

  if (!bundles.length) {
    bundlesList.innerHTML = `<div class="bundles-empty">No bundles match this filter</div>`;
    return;
  }

  bundlesList.innerHTML = bundles.map((b) => {
    const key = b.provider || state.activeNetwork;
    const available = b.available !== false;
    const cls = networkClass(key);
    return `
      <div class="bundle-card ${available ? '' : 'unavailable'}" data-plan-id="${escapeHtml(b.plan_id)}">
        <div class="bundle-logo ${cls}">${escapeHtml(networkShort(key))}</div>
        <div class="bundle-info">
          <div class="bundle-name">${escapeHtml(b.name)}</div>
          <div class="bundle-meta">
            <span>${escapeHtml(networkShort(key))}</span><span>·</span>
            <span>${escapeHtml(b.validity || '')}</span>
          </div>
          ${b.validity ? `<div><span class="bundle-tag">${escapeHtml(b.validity)}</span></div>` : ''}
        </div>
        <div class="bundle-right">
          <div class="bundle-price">${formatNaira(b.price)}</div>
          <div class="bundle-buy buy-${cls}">
            Buy
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
            </svg>
          </div>
        </div>
      </div>`;
  }).join('');

  bundlesList.querySelectorAll('.bundle-card').forEach((card) => {
    if (card.classList.contains('unavailable')) return;
    card.addEventListener('click', () => {
      const planId = card.dataset.planId;
      const bundle = state.bundles.find((b) => String(b.plan_id) === String(planId));
      if (bundle) selectBundle(bundle);
    });
  });

  requestAnimationFrame(() => {
    ensureAllSticky();
    setTimeout(ensureAllSticky, 250);
  });
}

function selectBundle(bundle) {
  state.selectedBundle = bundle;
  const key = bundle.provider || state.activeNetwork;
  const cls = networkClass(key);

  if (selectedBundleCard) {
    selectedBundleCard.dataset.provider = cls;
    selectedBundleCard.innerHTML = `
      <div class="sb-logo ${cls}">${escapeHtml(networkShort(key))}</div>
      <div class="sb-info">
        <div class="sb-name">${escapeHtml(bundle.name)}</div>
        <div class="sb-meta">
          <span class="sb-badge sb-${cls}">${escapeHtml(networkShort(key))}</span>
          <span>${escapeHtml(bundle.validity || '')}</span>
        </div>
      </div>
      <div class="sb-price">${formatNaira(bundle.price)}</div>`;
  }
  if (continueBtn) continueBtn.dataset.provider = cls;
  showStep(stepCheckout);
}

/* ============================================================
   MODE
   ============================================================ */
$$('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
  });
});

/* ============================================================
   PHONE INPUT
   ============================================================ */
if (phoneInput) {
  phoneInput.addEventListener('input', (e) => {
    e.target.value = smartNormalizePhone(e.target.value);
    phoneInput.classList.remove('error');
    phoneError?.classList.remove('show');
    updatePhoneSuggestions();
  });

  phoneInput.addEventListener('focus', () => {
    if (phoneInput.value.length < 11) {
      updatePhoneSuggestions();
    }
  });

  phoneInput.addEventListener('blur', () => {
    setTimeout(hidePhoneDropdown, 180);
  });

  phoneInput.addEventListener('paste', () => {
    setTimeout(() => {
      phoneInput.value = smartNormalizePhone(phoneInput.value);
      updatePhoneSuggestions();
    }, 0);
  });

  phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePhoneDropdown();
      phoneInput.blur();
    }
  });
}

document.addEventListener('click', (e) => {
  if (!phoneInputWrap) return;
  if (!phoneInputWrap.contains(e.target)) {
    hidePhoneDropdown();
  }
});

/* ============================================================
   CONTACT PICKER
   ============================================================ */
if (pickContactBtn) {
  pickContactBtn.addEventListener('click', async () => {
    if (!('contacts' in navigator) || !('select' in navigator.contacts)) {
      alert('Contact picker is not supported on this device.\n\nPlease type the phone number manually.');
      phoneInput?.focus();
      return;
    }
    const restore = spinButton(pickContactBtn, 'Opening…');
    try {
      const contacts = await navigator.contacts.select(['tel'], { multiple: false });
      restore();
      if (!contacts || !contacts.length) return;
      const telList = contacts[0].tel || [];
      if (!telList.length) { alert('That contact has no phone number.'); return; }
      let chosen = telList[0];
      const ngMobile = telList.find((t) => /^(\+?234|0)[789][01]\d{8}$/.test(String(t).replace(/\D/g, '')));
      if (ngMobile) chosen = ngMobile;
      const normalized = smartNormalizePhone(chosen);
      if (phoneInput) {
        phoneInput.value = normalized;
        phoneInput.classList.remove('error');
        phoneError?.classList.remove('show');
        hidePhoneDropdown();
      }
    } catch (err) {
      restore();
      if (err?.name === 'AbortError') return;
      alert('Could not open contacts. Please type the phone number.');
    }
  });
}

/* ============================================================
   CONTINUE
   ============================================================ */
if (continueBtn) {
  continueBtn.addEventListener('click', async () => {
    const phone = smartNormalizePhone(phoneInput.value.trim());
    if (!/^0\d{10}$/.test(phone)) {
      phoneInput.classList.add('error');
      phoneError?.classList.add('show');
      return;
    }
    state.phone = phone;
    const restore = spinButton(continueBtn, 'Continuing…');

    try {
      const fresh = await fetchWalletBalance();
      if (fresh !== null) state.walletBalance = fresh;
    } catch {}

    setTimeout(() => {
      const cls = networkClass(state.selectedBundle?.provider || state.activeNetwork);
      if (payNowBtn) payNowBtn.dataset.provider = cls;
      if (payBundleCard) {
        payBundleCard.dataset.provider = cls;
        payBundleCard.innerHTML = selectedBundleCard?.innerHTML || '';
      }
      if (payPhone) payPhone.textContent = phone;
      if (totalAmountEl) totalAmountEl.textContent = formatNaira(state.selectedBundle?.price || 0);
      if (walletBalanceEl) walletBalanceEl.textContent = formatNaira(state.walletBalance);
      updatePayButtonState();
      showStep(stepPay);
      restore();
    }, 320);
  });
}

/* ============================================================
   WALLET STATE
   ============================================================ */
function updatePayButtonState() {
  if (!payNowBtn) return;
  const balance = Number(state.walletBalance) || 0;
  const amount  = Number(state.selectedBundle?.price || 0);
  const shortfall = amount - balance;

  if (amount <= 0) { payNowBtn.disabled = true; payNowBtn.classList.remove('insufficient'); return; }

  if (state.paymentMethod === 'wallet' && balance < amount) {
    payNowBtn.disabled = true;
    payNowBtn.classList.add('insufficient');
    payNowBtn.textContent = 'Insufficient Balance';
    if (balanceWarning) balanceWarning.classList.remove('hidden');
    if (balanceWarningText) {
      balanceWarningText.innerHTML =
        `You have <strong>${formatNaira(balance)}</strong> in your wallet, ` +
        `but this purchase costs <strong>${formatNaira(amount)}</strong>. ` +
        `You need <strong>${formatNaira(shortfall)}</strong> more.`;
    }
  } else {
    payNowBtn.disabled = false;
    payNowBtn.classList.remove('insufficient');
    payNowBtn.textContent = 'Pay Now';
    if (balanceWarning) balanceWarning.classList.add('hidden');
  }
}

if (fundWalletBtn) fundWalletBtn.addEventListener('click', () => { window.location.href = '/fund-wallet.html'; });

$$('.pay-option').forEach((opt) => {
  opt.addEventListener('click', () => {
    $$('.pay-option').forEach((o) => o.classList.remove('active'));
    opt.classList.add('active');
    state.paymentMethod = opt.dataset.method;
    updatePayButtonState();
  });
});

/* ============================================================
   BACK BUTTONS
   ============================================================ */
$('#backToCategories')?.addEventListener('click', function () {
  const restore = spinButton(this, 'Going back…');
  setTimeout(() => { showStep(stepCategories); restore(); }, 200);
});
$('#backToBundles')?.addEventListener('click', function () {
  const restore = spinButton(this, 'Going back…');
  setTimeout(() => { showStep(stepBundles); restore(); }, 200);
});
$('#backToCheckout')?.addEventListener('click', function () {
  const restore = spinButton(this, 'Going back…');
  setTimeout(() => { showStep(stepCheckout); restore(); }, 200);
});

/* ============================================================
   PURCHASE MODAL
   ============================================================ */
function openPurchaseModal() {
  if (!purchaseModal) return;
  purchaseModal.classList.remove('hidden');
  requestAnimationFrame(() => purchaseModal.classList.add('show'));
  document.body.style.overflow = 'hidden';
}

function closePurchaseModal() {
  if (!purchaseModal) return;
  cancelAutoReturn();
  stopPolling();
  purchaseModal.classList.remove('show');
  document.body.style.overflow = '';
  setTimeout(() => purchaseModal.classList.add('hidden'), 260);
}

function setTrackerState(active) {
  if (!pmTracker) return;
  pmTracker.querySelectorAll('.pm-step').forEach((el) => {
    const key = el.dataset.step;
    const dot = el.querySelector('.pm-dot');
    if (!dot) return;
    dot.classList.remove('pm-dot-done', 'pm-dot-idle', 'pm-dot-processing', 'pm-dot-failed');

    let s = 'idle';
    if (key === 'submitted') {
      s = 'done';
    } else if (key === 'processing') {
      if (active === 'processing') s = 'processing';
      else if (active === 'completed') s = 'done';
      else if (active === 'refunded') s = 'done';
      else if (active === 'failed') s = 'failed';
    } else if (key === 'completed') {
      if (active === 'completed') s = 'done';
      else if (active === 'refunded') s = 'done';
      else if (active === 'failed') s = 'failed';
    }
    dot.classList.add(`pm-dot-${s}`);
  });
}

function applyHeroState(status) {
  if (!pmHero) return;
  pmHero.classList.remove('pm-hero-success', 'pm-hero-processing', 'pm-hero-failed', 'pm-hero-refunded');
  if (status === 'processing' || status === 'pending') pmHero.classList.add('pm-hero-processing');
  else if (status === 'success')                       pmHero.classList.add('pm-hero-success');
  else if (status === 'refunded')                      pmHero.classList.add('pm-hero-refunded');
  else                                                 pmHero.classList.add('pm-hero-failed');
}

function applyModalNetworkColor() {
  const cls = networkClass(state.selectedBundle?.provider || state.activeNetwork);
  if (pmDone) pmDone.dataset.provider = cls;
}

/* ── Auto-return (only after FINAL status) ── */
function scheduleAutoReturn(delayMs) {
  cancelAutoReturn();

  let remaining = Math.ceil(delayMs / 1000);
  let countEl = document.getElementById('pmCountdown');
  if (!countEl) {
    countEl = document.createElement('div');
    countEl.id = 'pmCountdown';
    countEl.style.cssText = `
      text-align: center; font-size: 11.5px;
      color: #64748b; margin-top: 10px;
      font-weight: 500; letter-spacing: 0.2px;
    `;
    const foot = document.querySelector('.purchase-sheet-foot');
    if (foot) foot.appendChild(countEl);
  }
  countEl.textContent = `Returning home in ${remaining}s…`;

  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      return;
    }
    if (countEl) countEl.textContent = `Returning home in ${remaining}s…`;
  }, 1000);

  autoReturnTimer = setTimeout(() => {
    try { closePurchaseModal(); } catch {}
    window.location.replace('/home.html');
  }, delayMs);
}

function cancelAutoReturn() {
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  const countEl = document.getElementById('pmCountdown');
  if (countEl) countEl.remove();
}

/* ── Central place to handle any status (initial or from poll) ── */
function applyStatusToModal(data) {
  const status    = String(data?.status || 'success').toLowerCase();
  const ambiguous = !!data?.ambiguous;
  const hint      = data?.hint || null;
  const remark    = data?.remark || '';

  applyModalNetworkColor();
  applyHeroState(status);

  const heroTitleText = {
    success:    'Successful',
    processing: 'Processing',
    pending:    'Processing',
    refunded:   'Refunded',
    failed:     'Failed',
  }[status] || 'Processing';

  const heroSubText = {
    success:    'completed',
    processing: 'confirming with provider',
    pending:    'confirming with provider',
    refunded:   'money returned',
    failed:     'not completed',
  }[status] || 'processing';

  if (pmHeroTitle) pmHeroTitle.textContent = heroTitleText;
  if (pmHeroSub)   pmHeroSub.textContent   = heroSubText;
  if (pmProduct)   pmProduct.textContent   = data?.product || 'data';
  if (pmAmount)    pmAmount.textContent    = formatNaira(data?.amount || 0);
  if (pmRecipient) pmRecipient.textContent = data?.recipient || '—';
  if (pmReference) pmReference.textContent = data?.reference || '—';

  /* Remark — merge backend hint when ambiguous */
  if (pmRemark) {
    if (ambiguous && hint) {
      pmRemark.textContent = hint;
    } else if (status === 'processing' || status === 'pending') {
      pmRemark.textContent = remark || 'We are confirming with the provider.';
    } else if (status === 'success') {
      pmRemark.textContent = remark || 'Purchase completed successfully.';
    } else if (status === 'failed') {
      pmRemark.textContent = remark || 'Purchase could not be completed.';
    } else if (status === 'refunded') {
      pmRemark.textContent = remark || 'Funds returned to your wallet.';
    } else {
      pmRemark.textContent = remark || 'Processing…';
    }
  }

  if (pmExtra) pmExtra.classList.remove('hidden');

  setTrackerState(
    status === 'success'  ? 'completed' :
    status === 'refunded' ? 'refunded' :
    status === 'failed'   ? 'failed' :
    'processing'
  );

  lastPurchase = { ...data, status };

  /* ── Final status? → schedule auto-return ── */
  if (status === 'success') {
    scheduleAutoReturn(RETURN_SUCCESS_MS);
  } else if (status === 'refunded') {
    scheduleAutoReturn(RETURN_REFUND_MS);
  } else if (status === 'failed') {
    scheduleAutoReturn(RETURN_FAILED_MS);
  } else {
    /* Still processing — NO auto-return. Keep modal open. */
    cancelAutoReturn();
  }
}

function showPurchaseUpdate(data) {
  openPurchaseModal();
  applyStatusToModal(data);
}

/* MODAL EVENTS */
if (pmCopy) {
  pmCopy.addEventListener('click', async () => {
    if (!pmRemark) return;
    try {
      await navigator.clipboard.writeText(pmRemark.textContent || '');
      pmCopy.style.color = '#0a7d4f';
      setTimeout(() => { pmCopy.style.color = ''; }, 900);
    } catch {}
  });
}

if (pmClose) pmClose.addEventListener('click', closePurchaseModal);

if (pmDone) {
  pmDone.addEventListener('click', () => {
    cancelAutoReturn();
    closePurchaseModal();
    setTimeout(() => { window.location.replace('/home.html'); }, 260);
  });
}

if (purchaseModal) {
  purchaseModal.addEventListener('click', (e) => {
    if (e.target === purchaseModal) closePurchaseModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && purchaseModal && !purchaseModal.classList.contains('hidden')) {
    closePurchaseModal();
  }
});

/* ── Refresh button ── */
if (pmRefresh) {
  pmRefresh.addEventListener('click', async () => {
    if (!lastPurchase?.reference) return;
    const original = pmRefresh.innerHTML;
    pmRefresh.disabled = true;
    pmRefresh.innerHTML = '<span class="pm-spin"></span> Refreshing…';

    try {
      const data = await fetchDataStatus(lastPurchase.reference);
      if (data) {
        applyStatusToModal({ ...lastPurchase, ...data });
        try {
          const fresh = await fetchWalletBalance();
          if (fresh !== null) {
            state.walletBalance = fresh;
            localStorage.setItem('walletBalance', String(fresh));
          }
        } catch {}
        /* If still processing, keep polling */
        if (String(data.status || '').toLowerCase() === 'processing' && !pollTimer) {
          startPolling(lastPurchase.reference);
        }
      }
    } finally {
      pmRefresh.disabled = false;
      pmRefresh.innerHTML = original;
    }
  });
}

/* ── Share button ── */
if (pmShare) {
  pmShare.addEventListener('click', async () => {
    if (!lastPurchase) return;
    const text =
      `Shatova Receipt\n─────────────\n` +
      `${lastPurchase.product || 'Data Purchase'}\n` +
      `Amount: ${formatNaira(lastPurchase.amount || 0)}\n` +
      `Status: ${lastPurchase.status || 'success'}\n` +
      `Reference: ${lastPurchase.reference || '—'}\n` +
      `Recipient: ${lastPurchase.recipient || '—'}\n` +
      `Remark: ${lastPurchase.remark || ''}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Shatova Receipt', text }); } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        pmShare.style.color = '#059669';
        setTimeout(() => { pmShare.style.color = ''; }, 900);
      } catch {}
    }
  });
}

/* ── Print button ── */
if (pmPrint) {
  pmPrint.addEventListener('click', () => {
    if (!lastPurchase) return;
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    w.document.write(`
      <!DOCTYPE html><html><head><title>Shatova Receipt</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 24px; color: #0f172a; max-width: 340px; margin: 0 auto; }
        .head { text-align: center; padding-bottom: 16px; border-bottom: 2px dashed #e2e8f0; margin-bottom: 16px; }
        .brand { font-size: 20px; font-weight: 800; color: #0a4534; }
        .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
        .amount { font-size: 28px; font-weight: 800; margin: 16px 0 4px; text-align: center; }
        .status { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #047857; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
        .label { color: #64748b; } .value { font-weight: 700; text-align: right; max-width: 60%; }
        .remark { margin-top: 12px; padding: 10px; background: #f7f9f8; border-radius: 8px; font-size: 12px; color: #334155; line-height: 1.5; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 2px dashed #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
      </style></head><body>
      <div class="head"><div class="brand">SHATOVA</div><div class="sub">Data Purchase Receipt</div></div>
      <div class="amount">${formatNaira(lastPurchase.amount || 0)}</div>
      <div class="status">${lastPurchase.status || 'success'}</div>
      <div class="row"><span class="label">Product</span><span class="value">${lastPurchase.product || 'Data'}</span></div>
      <div class="row"><span class="label">Recipient</span><span class="value">${lastPurchase.recipient || '—'}</span></div>
      <div class="row"><span class="label">Reference</span><span class="value">${lastPurchase.reference || '—'}</span></div>
      <div class="remark">${lastPurchase.remark || ''}</div>
      <div class="footer">Thank you for using Shatova 💚</div>
      <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
      </body></html>
    `);
    w.document.close();
  });
}

/* ============================================================
   POLLING — smarter interval, stops on final status
   ============================================================ */
function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startPolling(reference) {
  stopPolling();
  let attempts = 0;

  const tick = async () => {
    attempts++;
    const data = await fetchDataStatus(reference);

    /* On network failure just try again until max attempts */
    if (!data) {
      if (attempts >= POLL_MAX_ATTEMPTS) return;
      scheduleNext();
      return;
    }

    const status = String(data.status || '').toLowerCase();

    /* Update wallet if it changed */
    if (status === 'success' || status === 'refunded' || status === 'failed') {
      try {
        const fresh = await fetchWalletBalance();
        if (fresh !== null) {
          state.walletBalance = fresh;
          localStorage.setItem('walletBalance', String(fresh));
        }
      } catch {}
    }

    /* Apply status to modal — this also handles auto-return */
    applyStatusToModal({ ...lastPurchase, ...data });

    /* Stop on final status */
    if (status === 'success' || status === 'failed' || status === 'refunded') {
      stopPolling();
      return;
    }

    /* Keep polling */
    if (attempts >= POLL_MAX_ATTEMPTS) {
      stopPolling();
      if (pmRemark && String(pmRemark.textContent || '').toLowerCase().includes('confirm')) {
        pmRemark.textContent = 'Still confirming. You can tap Refresh to check again.';
      }
      return;
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    const delay = attempts < POLL_FAST_LIMIT ? POLL_FAST_INTERVAL_MS : POLL_SLOW_INTERVAL_MS;
    pollTimer = setTimeout(tick, delay);
  };

  /* First poll after a short delay */
  pollTimer = setTimeout(tick, 1500);
}

/* ============================================================
   PAY NOW
   ============================================================ */
if (payNowBtn) {
  payNowBtn.addEventListener('click', async () => {
    const amount  = Number(state.selectedBundle?.price || 0);
    const balance = Number(state.walletBalance) || 0;

    if (state.paymentMethod === 'wallet' && balance < amount) { updatePayButtonState(); return; }
    if (!state.selectedBundle) {
      alert('Please select a data plan first.');
      showStep(stepCategories);
      return;
    }

    payNowBtn.disabled = true;
    payNowBtn.classList.remove('insufficient');
    payNowBtn.innerHTML = '<span class="spinner-inline"></span> Processing…';

    try {
      const planId = state.selectedBundle.plan_id;
      const result = await purchaseData(planId, state.phone, state.mode, state.paymentMethod);

      const status = String(result?.status || 'success').toLowerCase();
      state.currentReference = result?.reference || null;

      /* Optimistic wallet update for success */
      if (status === 'success') {
        state.walletBalance = Math.max(0, balance - amount);
        localStorage.setItem('walletBalance', String(state.walletBalance));
      } else {
        /* For processing / failed — fetch fresh to reflect hold state */
        try {
          const fresh = await fetchWalletBalance();
          if (fresh !== null) {
            state.walletBalance = fresh;
            localStorage.setItem('walletBalance', String(fresh));
          }
        } catch {}
      }

      /* Show the modal with full backend context */
      showPurchaseUpdate({
        status,
        ambiguous: !!result?.ambiguous,
        hint:      result?.hint || null,
        product:   result?.product || state.selectedBundle?.name || 'Data bundle',
        amount:    result?.amount  || amount,
        remark:    result?.remark  || '',
        recipient: result?.phone   || state.phone,
        reference: result?.reference || state.currentReference || '—',
      });

      /* If processing → start polling */
      if (status === 'processing' || status === 'pending') {
        if (state.currentReference) startPolling(state.currentReference);
      }

      /* Refresh recent recipients in background */
      fetchRecentRecipients().then((list) => {
        state.recentRecipients = Array.isArray(list) ? list : [];
      });

    } catch (err) {
      console.error('[data] purchase:', err);

      if (err.code === 'INSUFFICIENT_BALANCE') {
        const bal = Number(err.data?.balance ?? state.walletBalance);
        state.walletBalance = bal;
        if (walletBalanceEl) walletBalanceEl.textContent = formatNaira(bal);
        updatePayButtonState();
        return;
      }

      if (err.code === 'NETWORK_MISMATCH') {
        showPurchaseUpdate({
          status:    'failed',
          product:   state.selectedBundle?.name || 'Data bundle',
          amount,
          remark:    err.message || `This number doesn't match ${networkDisplay(state.activeProvider)}. Please select the correct network.`,
          recipient: state.phone,
          reference: '—',
        });
        return;
      }

      /* Generic failure — show modal, no polling */
      showPurchaseUpdate({
        status:    'failed',
        product:   state.selectedBundle?.name || 'Data bundle',
        amount,
        remark:    err.message || 'Purchase failed. Please try again.',
        recipient: state.phone,
        reference: err.data?.reference || '—',
      });

      try {
        const fresh = await fetchWalletBalance();
        if (fresh !== null) {
          state.walletBalance = fresh;
          localStorage.setItem('walletBalance', String(fresh));
        }
      } catch {}

    } finally {
      payNowBtn.disabled = false;
      updatePayButtonState();
    }
  });
}

/* ============================================================
   PLACEHOLDERS
   ============================================================ */
$('#scheduleLink')?.addEventListener('click', function () {
  const restore = spinButton(this, 'Loading…');
  setTimeout(() => { restore(); alert('Scheduled purchases coming soon.'); }, 250);
});

/* ============================================================
   SPINNER STYLES
   ============================================================ */
(function injectSpinnerStyle() {
  if (document.getElementById('data-spinner-style')) return;
  const style = document.createElement('style');
  style.id = 'data-spinner-style';
  style.textContent = `
    .spinner-dark {
      display: inline-block; width: 16px; height: 16px;
      border-radius: 50%; border: 2.5px solid rgba(10, 69, 52, 0.2);
      border-top-color: #0a4534; animation: dataSpin 0.65s linear infinite;
      vertical-align: middle;
    }
    .spinner-inline {
      display: inline-block; width: 15px; height: 15px;
      border-radius: 50%; border: 2.5px solid rgba(255, 255, 255, 0.35);
      border-top-color: #ffffff; animation: dataSpin 0.65s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    .btn-primary[data-provider="mtn"] .spinner-inline,
    .bundle-buy.buy-mtn .spinner-inline {
      border-color: rgba(10, 10, 10, 0.25);
      border-top-color: #0a0a0a;
    }
    @keyframes dataSpin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
})();

/* ============================================================
   BOOT
   ============================================================ */
async function init() {
  if (!getToken()) { redirectToLogin(); return; }

  mountCategoryHeader({
    eyebrow: 'Service',
    title: 'Data Bundles',
    showBack: true,
    backHref: '/home.html',
    showChips: true,
    activeNetwork: 'all',
  });

  pageHeadSlot?.addEventListener('network:change', (e) => selectNetwork(e.detail.network));

  try {
    const [user, networks] = await Promise.all([fetchMe(), fetchNetworks()]);
    if (user) state.walletBalance = Number(user.balance ?? user.wallet?.balance ?? 0);
    try {
      const fresh = await fetchWalletBalance();
      if (fresh !== null) state.walletBalance = fresh;
    } catch {}
    state.networks = networks;
    selectNetwork('all');

    fetchRecentRecipients().then((list) => {
      state.recentRecipients = Array.isArray(list) ? list : [];
      console.log(`[data] loaded ${state.recentRecipients.length} recent recipients`);
    });

    requestAnimationFrame(() => {
      ensureAllSticky();
      setTimeout(ensureAllSticky, 500);
    });
  } catch (err) {
    console.error('[data] init:', err);
    if (categoryList) categoryList.innerHTML = `<div class="bundles-empty">${escapeHtml(err.message || 'Error')}</div>`;
  }
}

init();