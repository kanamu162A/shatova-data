// frontend/js/airtime.js
// ============================================================
// Shatova — Airtime Purchase Flow
//   • 2% user discount on ₦100+
//   • Real network logos (MTN / Airtel / Glo / 9mobile)
//   • Recent recipients — NETWORK-FILTERED dropdown
//   • Every remark sanitized — internal errors never reach users
// ============================================================

const API_BASE = window.API_BASE;

const USER_DISCOUNT_PCT     = 2;
const USER_DISCOUNT_MIN     = 100;
const USER_MIN_AMOUNT       = 10;
const USER_MAX_AMOUNT       = 50000;

const POLL_INTERVAL_MS      = 5000;
const POLL_MAX_ATTEMPTS     = 24;
const AUTO_RETURN_DELAY_MS  = 30 * 1000;
const QUICK_RETURN_MS       = 4 * 1000;

const NG_PREFIXES = {
  mtn:     ['0803','0806','0703','0706','0813','0816','0810','0814','0903','0906','0913','0916','0704'],
  airtel:  ['0802','0808','0708','0812','0701','0902','0901','0907','0912','0911'],
  glo:     ['0805','0807','0705','0815','0811','0905','0915'],
  '9mobile': ['0809','0817','0818','0908','0909'],
};
const MTN_5DIGIT = ['07025', '07026'];

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

const state = {
  networks: [],
  products: [],
  activeNetwork: null,
  selectedProduct: null,
  mode: 'single',
  phone: '',
  amount: 0,
  paymentMethod: 'wallet',
  walletBalance: 0,
  prefixNetwork: null,
  currentReference: null,
  allRecipients: [],
};

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const stepCategories = $('#step-categories');
const stepBundles    = $('#step-bundles');
const stepCheckout   = $('#step-checkout');
const stepPay        = $('#step-pay');

const categoryList = $('#categoryList');
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
const amountInput    = $('#amountInput');
const amountError    = $('#amountError');
const continueBtn    = $('#continueBtn');
const payNowBtn      = $('#payNowBtn');
const pickContactBtn = $('#pickContact');
const quickAmounts   = $('#quickAmounts');

const balanceWarning     = $('#balanceWarning');
const balanceWarningText = $('#balanceWarningText');
const fundWalletBtn      = $('#fundWalletBtn');

const networkBadge     = $('#networkBadge');
const recentRecipients = $('#recentRecipients');
const rrList           = $('#rrList');

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
let quickReturnTimer  = null;
let countdownInterval = null;

/* ============================================================
   STEP NAVIGATION
   ============================================================ */
function showStep(step) {
  [stepCategories, stepBundles, stepCheckout, stepPay]
    .forEach((s) => s && s.classList.add('hidden'));
  if (step) step.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   FORMATTERS
   ============================================================ */
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

/* ============================================================
   REMARK SANITIZER
   ============================================================ */
function sanitizeRemark(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const internal = [
    /insufficient wallet balance/i,
    /insufficient balance/i,
    /wallet balance/i,
    /provider failed/i,
    /no working status/i,
    /datashop/i,
    /upstream/i,
    /hold \(requested/i,
    /internal error/i,
    /5\d{2}\b/,
    /timeout/i,
    /econnrefused/i,
    /enotfound/i,
  ];
  if (internal.some((rx) => rx.test(s))) {
    return 'Service temporarily unavailable. Please try again in a moment.';
  }
  return s;
}

/* ============================================================
   NETWORK HELPERS
   ============================================================ */
function networkClass(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('mtn')) return 'mtn';
  if (k.includes('airtel')) return 'airtel';
  if (k.includes('glo')) return 'glo';
  if (k.includes('t2')) return 't2';
  if (k.includes('9mobile') || k.includes('etisalat')) return 't2';
  return 'mtn';
}

function networkShort(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('mtn')) return 'MTN';
  if (k.includes('airtel')) return 'AIRTEL';
  if (k.includes('glo')) return 'GLO';
  if (k.includes('t2')) return '9MOBILE';
  if (k.includes('9mobile') || k.includes('etisalat')) return '9MOBILE';
  return String(key).toUpperCase().slice(0, 6);
}

function networkDisplay(key) {
  const k = String(key || '').toLowerCase();
  if (k === 't2' || k === 'etisalat') return '9mobile';
  if (k === 'mtn') return 'MTN';
  if (k === 'airtel') return 'Airtel';
  if (k === 'glo') return 'Glo';
  if (k === '9mobile') return '9mobile';
  return k.toUpperCase();
}

/* ⭐ Real logo HTML — uses window.networkLogoHTML injected in airtime.html */
function networkLogoFor(key, opts = {}) {
  if (typeof window.networkLogoHTML !== 'function') return '';
  return window.networkLogoHTML(key, opts);
}

function normalizeNgPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('234') && p.length > 10) p = '0' + p.slice(3);
  if (p.length > 0 && /^[789]/.test(p)) p = '0' + p;
  return p.slice(0, 11);
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

function detectNetworkFromPrefix(phone) {
  const p = normalizeNgPhone(phone);
  if (p.length !== 11) return null;
  const p4 = p.slice(0, 4);
  const p5 = p.slice(0, 5);
  if (MTN_5DIGIT.includes(p5)) return 'mtn';
  for (const [network, prefixes] of Object.entries(NG_PREFIXES)) {
    if (prefixes.includes(p4)) return network;
  }
  return null;
}

function phoneBelongsToNetwork(phone, networkKey) {
  if (!phone || !networkKey) return false;
  const detected = detectNetworkFromPrefix(phone);
  if (!detected) return false;
  const n = String(networkKey).toLowerCase();
  if (detected === n) return true;
  if ((detected === '9mobile' && n === 't2') || (detected === 't2' && n === '9mobile')) return true;
  return false;
}

/* ============================================================
   PRICING
   ============================================================ */
function calculateUserPrice(amount) {
  const amt = Number(amount) || 0;
  if (amt >= USER_DISCOUNT_MIN) {
    const discount = amt * (USER_DISCOUNT_PCT / 100);
    return Math.round((amt - discount) * 100) / 100;
  }
  return amt;
}
function calculateDiscountAmount(amount) {
  const amt = Number(amount) || 0;
  if (amt >= USER_DISCOUNT_MIN) {
    return Math.round((amt * (USER_DISCOUNT_PCT / 100)) * 100) / 100;
  }
  return 0;
}
function hasDiscount(amount) { return Number(amount) >= USER_DISCOUNT_MIN; }

function updatePayButtonState() {
  if (!payNowBtn) return;
  const balance = Number(state.walletBalance) || 0;
  const amount = Number(state.amount) || 0;
  const userPrice = calculateUserPrice(amount);
  const shortfall = userPrice - balance;

  if (amount <= 0) {
    payNowBtn.disabled = true;
    payNowBtn.classList.remove('insufficient');
    return;
  }

  if (balance < userPrice) {
    payNowBtn.disabled = true;
    payNowBtn.classList.add('insufficient');
    payNowBtn.textContent = 'Insufficient Balance';
    if (balanceWarning) balanceWarning.classList.remove('hidden');
    if (balanceWarningText) {
      balanceWarningText.innerHTML =
        `You have <strong>${formatNaira(balance)}</strong> in your wallet, ` +
        `but this purchase costs <strong>${formatNaira(userPrice)}</strong>` +
        (hasDiscount(amount) ? ` (after ${USER_DISCOUNT_PCT}% discount)` : '') +
        `. You need <strong>${formatNaira(shortfall)}</strong> more.`;
    }
  } else {
    payNowBtn.disabled = false;
    payNowBtn.classList.remove('insufficient');
    payNowBtn.textContent = 'Pay Now';
    if (balanceWarning) balanceWarning.classList.add('hidden');
  }
}

/* ============================================================
   API CALLS
   ============================================================ */
async function fetchWalletBalance() {
  try {
    const res = await fetch(`${API_BASE}/airtime/balance`, { headers: authHeaders() });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    if (!json.success) return null;
    return Number(json.data?.balance ?? 0);
  } catch { return null; }
}

async function fetchNetworks() {
  const res = await fetch(`${API_BASE}/airtime/networks`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return []; }
  if (res.status === 404) return [];
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load networks');
  return json.data?.networks || [];
}

async function fetchProducts(networkKey) {
  const res = await fetch(
    `${API_BASE}/airtime/products?network=${encodeURIComponent(networkKey)}`,
    { headers: authHeaders() }
  );
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return []; }
  if (res.status === 404) return [];
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load products');
  return json.data?.products || [];
}

async function fetchMe() {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return json.data?.user || json.user || null;
}

async function purchaseAirtime(payload) {
  const res = await fetch(`${API_BASE}/airtime/purchase`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
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

async function fetchTransactionStatus(reference) {
  try {
    const res = await fetch(
      `${API_BASE}/airtime/status?reference=${encodeURIComponent(reference)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    if (!json.success) return null;
    return json.data;
  } catch { return null; }
}

/* ⭐ Recent recipients — /wallet/recent-recipients */
async function fetchRecentRecipients() {
  try {
    const res = await fetch(`${API_BASE}/wallet/recent-recipients`, { headers: authHeaders() });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const list = json.data?.recipients || json.recipients || [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/* ============================================================
   RECENT RECIPIENTS — NETWORK-FILTERED DROPDOWN
   ============================================================ */
function hideSuggestions() {
  if (recentRecipients) recentRecipients.classList.add('hidden');
  if (rrList) rrList.innerHTML = '';
}

function updateSuggestions() {
  if (!recentRecipients || !rrList) return;

  const typed = normalizeNgPhone(phoneInput?.value || '');
  const activeNet = state.activeNetwork;

  if (!activeNet) { hideSuggestions(); return; }
  if (typed.length >= 11) { hideSuggestions(); return; }

  let matches = state.allRecipients.filter((r) => {
    const phone = normalizeNgPhone(r.phone || r.msisdn || r.number || '');
    if (!phone) return false;
    return phoneBelongsToNetwork(phone, activeNet);
  });

  if (typed.length >= 1) {
    matches = matches.filter((r) =>
      normalizeNgPhone(r.phone || r.msisdn || r.number || '').startsWith(typed)
    );
  }

  // Deduplicate by phone
  const seen = new Set();
  matches = matches.filter((r) => {
    const p = normalizeNgPhone(r.phone || r.msisdn || r.number || '');
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  matches = matches.slice(0, 5);

  if (!matches.length) { hideSuggestions(); return; }

  rrList.innerHTML = matches.map((r) => {
    const phone = normalizeNgPhone(r.phone || r.msisdn || r.number || '');
    const label = r.name || r.label || '';
    return `
      <button type="button" class="phone-dropdown-item" data-phone="${escapeHtml(phone)}">
        <span class="rr-phone">${escapeHtml(phone)}</span>
        ${label ? `<span class="rr-name">${escapeHtml(label)}</span>` : ''}
      </button>
    `;
  }).join('');

  recentRecipients.classList.remove('hidden');

  rrList.querySelectorAll('.phone-dropdown-item').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      phoneInput.value = normalizeNgPhone(btn.dataset.phone);
      phoneInput.classList.add('filled');
      setTimeout(() => phoneInput.classList.remove('filled'), 700);
      clearPhoneError();
      hideSuggestions();
      detectNetworkLive();
      amountInput?.focus();
    });
  });
}

function renderRecentRecipients(list) {
  state.allRecipients = Array.isArray(list) ? list : [];
  hideSuggestions();
}

/* ============================================================
   NETWORK BADGE
   ============================================================ */
let detectTimer = null;

function showNetworkBadge(kind, text) {
  if (!networkBadge) return;
  networkBadge.classList.remove('hidden', 'nb-detecting', 'nb-match', 'nb-mismatch', 'nb-unknown');
  networkBadge.classList.add(kind);
  const label = networkBadge.querySelector('.nb-text');
  if (label) label.textContent = text;
}
function hideNetworkBadge() {
  if (!networkBadge) return;
  networkBadge.classList.add('hidden');
}

function detectNetworkLive() {
  const raw = phoneInput?.value || '';
  const phone = normalizeNgPhone(raw);

  if (phone.length !== 11) {
    state.prefixNetwork = null;
    hideNetworkBadge();
    return;
  }

  const detected = detectNetworkFromPrefix(phone);
  state.prefixNetwork = detected;

  if (!detected) { hideNetworkBadge(); return; }

  const selected = state.activeNetwork;
  const matches =
    detected === selected ||
    (detected === '9mobile' && selected === 't2') ||
    (detected === 't2' && selected === '9mobile');

  if (matches) showNetworkBadge('nb-match', `${networkDisplay(detected)} number`);
  else hideNetworkBadge();
}

/* ============================================================
   PURCHASE UPDATE MODAL
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
  cancelQuickReturn();
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
    if (key === 'submitted') s = 'done';
    else if (key === 'processing') {
      if (active === 'processing') s = 'processing';
      else if (active === 'completed' || active === 'refunded') s = 'done';
      else if (active === 'failed') s = 'failed';
    } else if (key === 'completed') {
      if (active === 'completed' || active === 'refunded') s = 'done';
      else if (active === 'failed') s = 'failed';
    }
    dot.classList.add(`pm-dot-${s}`);
  });
}

function applyHeroState(status) {
  if (!pmHero) return;
  pmHero.classList.remove('pm-hero-success', 'pm-hero-processing', 'pm-hero-failed', 'pm-hero-refunded');
  if (status === 'processing' || status === 'pending') pmHero.classList.add('pm-hero-processing');
  else if (status === 'success') pmHero.classList.add('pm-hero-success');
  else if (status === 'refunded') pmHero.classList.add('pm-hero-refunded');
  else pmHero.classList.add('pm-hero-failed');
}

function applyModalNetworkColor() {
  const cls = networkClass(state.selectedProduct?.provider || state.activeNetwork);
  if (pmDone) pmDone.dataset.provider = cls;
}

function scheduleAutoReturn() {
  cancelAutoReturn();
  let remaining = Math.floor(AUTO_RETURN_DELAY_MS / 1000);
  let countEl = document.getElementById('pmCountdown');
  if (!countEl) {
    countEl = document.createElement('div');
    countEl.id = 'pmCountdown';
    countEl.style.cssText = `
      text-align: center;
      font-size: 11.5px;
      color: #64748b;
      margin-top: 10px;
      font-weight: 500;
      letter-spacing: 0.2px;
    `;
    const foot = document.querySelector('.purchase-sheet-foot');
    if (foot) foot.appendChild(countEl);
  }
  countEl.textContent = `Returning to home in ${remaining}s…`;
  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(countdownInterval); countdownInterval = null; return; }
    if (countEl) countEl.textContent = `Returning to home in ${remaining}s…`;
  }, 1000);
  autoReturnTimer = setTimeout(() => {
    try { closePurchaseModal(); } catch {}
    window.location.href = '/home.html';
  }, AUTO_RETURN_DELAY_MS);
}
function cancelAutoReturn() {
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  const countEl = document.getElementById('pmCountdown');
  if (countEl) countEl.remove();
}

function scheduleQuickReturn(delayMs = QUICK_RETURN_MS) {
  cancelQuickReturn();
  quickReturnTimer = setTimeout(() => {
    try { closePurchaseModal(); } catch {}
    window.location.href = '/home.html';
  }, delayMs);
}
function cancelQuickReturn() {
  if (quickReturnTimer) { clearTimeout(quickReturnTimer); quickReturnTimer = null; }
}

function showPurchaseUpdate(data) {
  const status = (data.status || 'success').toLowerCase();
  applyModalNetworkColor();
  applyHeroState(status);

  const heroTitleText = {
    success: 'successful',
    processing: 'processing',
    pending: 'processing',
    refunded: 'refunded',
    failed: 'failed',
  }[status] || status;

  const heroSubText = {
    success: 'success',
    processing: 'in progress',
    pending: 'in progress',
    refunded: 'money returned',
    failed: 'failed',
  }[status] || status;

  if (pmHeroTitle) pmHeroTitle.textContent = heroTitleText;
  if (pmHeroSub)   pmHeroSub.textContent   = heroSubText;
  if (pmProduct)   pmProduct.textContent   = data.product || 'airtime';
  if (pmAmount)    pmAmount.textContent    = formatNaira(data.amount || 0);
  if (pmRemark)    pmRemark.textContent    = sanitizeRemark(data.remark) || 'Processing';
  if (pmRecipient) pmRecipient.textContent = data.recipient || '—';
  if (pmReference) pmReference.textContent = data.reference || '—';
  if (pmExtra)     pmExtra.classList.remove('hidden');

  setTrackerState(
    status === 'success' ? 'completed' :
    status === 'refunded' ? 'refunded' :
    status === 'failed' ? 'failed' : 'processing'
  );

  lastPurchase = { ...data, remark: sanitizeRemark(data.remark) || data.remark };
  openPurchaseModal();

  if (status === 'refunded' || status === 'failed') scheduleQuickReturn(QUICK_RETURN_MS);
  else scheduleAutoReturn();
}

/* ============================================================
   MODAL EVENTS
   ============================================================ */
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
    cancelQuickReturn();
    closePurchaseModal();
    setTimeout(() => { window.location.href = '/home.html'; }, 260);
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

if (pmRefresh) {
  pmRefresh.addEventListener('click', async () => {
    if (!lastPurchase?.reference) return;
    const original = pmRefresh.innerHTML;
    pmRefresh.disabled = true;
    pmRefresh.innerHTML = '<span class="pm-spin"></span> Refreshing…';
    try {
      const data = await fetchTransactionStatus(lastPurchase.reference);
      if (data) {
        const s = String(data.status || '').toLowerCase();
        const safeRemark = sanitizeRemark(data.remark);

        if (s === 'success') {
          applyHeroState('success');
          if (pmHeroTitle) pmHeroTitle.textContent = 'successful';
          if (pmHeroSub)   pmHeroSub.textContent   = 'success';
          if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
          setTrackerState('completed');
          stopPolling();
        } else if (s === 'refunded') {
          applyHeroState('refunded');
          if (pmHeroTitle) pmHeroTitle.textContent = 'refunded';
          if (pmHeroSub)   pmHeroSub.textContent   = 'money returned';
          if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
          setTrackerState('refunded');
          stopPolling();
        } else if (s === 'failed') {
          applyHeroState('failed');
          if (pmHeroTitle) pmHeroTitle.textContent = 'failed';
          if (pmHeroSub)   pmHeroSub.textContent   = 'failed';
          if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
          setTrackerState('failed');
          stopPolling();
        } else {
          if (pmRemark) pmRemark.textContent = safeRemark || 'Still processing';
          if (!pollTimer) startPolling(lastPurchase.reference);
        }

        try {
          const fresh = await fetchWalletBalance();
          if (fresh !== null) {
            state.walletBalance = fresh;
            localStorage.setItem('walletBalance', String(fresh));
          }
        } catch {}
      }
    } finally {
      pmRefresh.disabled = false;
      pmRefresh.innerHTML = original;
    }
  });
}

if (pmShare) {
  pmShare.addEventListener('click', async () => {
    if (!lastPurchase) return;
    const text =
      `Shatova Receipt\n─────────────\n` +
      `${lastPurchase.product || 'Airtime Purchase'}\n` +
      `Amount: ${formatNaira(lastPurchase.amount || 0)}\n` +
      `Status: ${lastPurchase.status || 'success'}\n` +
      `Reference: ${lastPurchase.reference || '—'}\n` +
      `Recipient: ${lastPurchase.recipient || '—'}\n` +
      `Remark: ${sanitizeRemark(lastPurchase.remark) || ''}`;
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

if (pmPrint) {
  pmPrint.addEventListener('click', () => {
    if (!lastPurchase) return;
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    const safeRemark = sanitizeRemark(lastPurchase.remark);
    w.document.write(`
      <!DOCTYPE html><html><head><title>Shatova Receipt</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 24px; color: #0f172a; max-width: 340px; margin: 0 auto; }
        .head { text-align: center; padding-bottom: 16px; border-bottom: 2px dashed #e2e8f0; margin-bottom: 16px; }
        .brand { font-size: 20px; font-weight: 800; color: #0a4534; }
        .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
        .amount { font-size: 28px; font-weight: 800; margin: 16px 0 4px; text-align: center; color: #111827; }
        .status { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #0a7d4f; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
        .label { color: #64748b; }
        .value { font-weight: 700; text-align: right; max-width: 60%; }
        .remark { margin-top: 16px; padding: 12px; background: #f7f9f8; border-radius: 8px; font-size: 12px; color: #334155; line-height: 1.5; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 2px dashed #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
      </style></head><body>
        <div class="head"><div class="brand">SHATOVA</div><div class="sub">Airtime Receipt</div></div>
        <div class="amount">${formatNaira(lastPurchase.amount || 0)}</div>
        <div class="status">${lastPurchase.status || 'success'}</div>
        <div class="row"><span class="label">Product</span><span class="value">${lastPurchase.product || 'Airtime'}</span></div>
        <div class="row"><span class="label">Recipient</span><span class="value">${lastPurchase.recipient || '—'}</span></div>
        <div class="row"><span class="label">Reference</span><span class="value">${lastPurchase.reference || '—'}</span></div>
        <div class="remark">${safeRemark || ''}</div>
        <div class="footer">Thank you for using Shatova</div>
        <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
      </body></html>
    `);
    w.document.close();
  });
}

/* ============================================================
   POLLING
   ============================================================ */
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling(reference) {
  stopPolling();
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts++;
    const data = await fetchTransactionStatus(reference);
    if (!data) {
      if (attempts >= POLL_MAX_ATTEMPTS) stopPolling();
      return;
    }
    const status = String(data.status || '').toLowerCase();
    const safeRemark = sanitizeRemark(data.remark);

    if (status === 'success') {
      stopPolling();
      applyHeroState('success');
      if (pmHeroTitle) pmHeroTitle.textContent = 'successful';
      if (pmHeroSub)   pmHeroSub.textContent   = 'success';
      if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
      setTrackerState('completed');
      try {
        const fresh = await fetchWalletBalance();
        if (fresh !== null) {
          state.walletBalance = fresh;
          localStorage.setItem('walletBalance', String(fresh));
        }
      } catch {}
      return;
    }
    if (status === 'refunded') {
      stopPolling();
      applyHeroState('refunded');
      if (pmHeroTitle) pmHeroTitle.textContent = 'refunded';
      if (pmHeroSub)   pmHeroSub.textContent   = 'money returned';
      if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
      setTrackerState('refunded');
      try {
        const fresh = await fetchWalletBalance();
        if (fresh !== null) {
          state.walletBalance = fresh;
          localStorage.setItem('walletBalance', String(fresh));
        }
      } catch {}
      scheduleQuickReturn(QUICK_RETURN_MS);
      return;
    }
    if (status === 'failed') {
      stopPolling();
      applyHeroState('failed');
      if (pmHeroTitle) pmHeroTitle.textContent = 'failed';
      if (pmHeroSub)   pmHeroSub.textContent   = 'failed';
      if (pmRemark && safeRemark) pmRemark.textContent = safeRemark;
      setTrackerState('failed');
      try {
        const fresh = await fetchWalletBalance();
        if (fresh !== null) {
          state.walletBalance = fresh;
          localStorage.setItem('walletBalance', String(fresh));
        }
      } catch {}
      scheduleQuickReturn(QUICK_RETURN_MS);
      return;
    }
    if (attempts >= POLL_MAX_ATTEMPTS) {
      stopPolling();
      if (pmRemark) pmRemark.textContent = 'Still processing. Tap Refresh Status to check again.';
    }
  }, POLL_INTERVAL_MS);
}

/* ============================================================
   STEP 1 — NETWORKS  (real logos)
   ============================================================ */
function renderCategories() {
  if (!categoryList) return;
  if (!state.networks.length) {
    categoryList.innerHTML = `<div class="bundles-empty">No networks available</div>`;
    return;
  }
  categoryList.innerHTML = state.networks.map((n) => {
    const key = n.key;
    const count = n.products || 1;
    return `
      <div class="category-card" data-provider="${escapeHtml(key)}">
        ${networkLogoFor(key, { alt: networkDisplay(key) })}
        <div class="cat-info">
          <div class="cat-name">${escapeHtml(networkDisplay(key))}</div>
          <div class="cat-sub">${count} product${count === 1 ? '' : 's'}</div>
        </div>
        <div class="cat-arrow">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
          </svg>
        </div>
      </div>`;
  }).join('');

  categoryList.querySelectorAll('.category-card').forEach((card) => {
    card.addEventListener('click', () => selectNetwork(card.dataset.provider));
  });
}

async function selectNetwork(key) {
  state.activeNetwork = key;

  if (bundlesTitle) {
    bundlesTitle.innerHTML =
      networkLogoFor(key, { size: 'sm', alt: networkDisplay(key) }) +
      `<span>${escapeHtml(networkDisplay(key))} Airtime</span>`;
  }
  if (bundlesSub) bundlesSub.textContent = `${networkShort(key)} AIRTIME · Loading…`;
  if (bundlesList) {
    bundlesList.innerHTML = `
      <div class="bundles-empty" style="padding: 32px 20px;">
        <span style="display:inline-flex;align-items:center;gap:8px;color:#0a4534;font-weight:600;">
          <span class="spinner-dark"></span> Loading…
        </span>
      </div>`;
  }
  showStep(stepBundles);

  try {
    let products = await fetchProducts(key);
    if (!products.length) {
      products = [{
        id: `${key}-airtime`,
        provider: key,
        name: `${networkDisplay(key)} Airtime`,
        description: `${networkDisplay(key)} Instant recharge`,
        available: true,
      }];
    }
    state.products = products;
    if (bundlesSub) {
      bundlesSub.textContent =
        `${networkShort(key)} AIRTIME · ${products.length} product${products.length === 1 ? '' : 's'}`;
    }
    renderProducts();
  } catch (err) {
    console.error('[airtime] products:', err);
    if (bundlesList) bundlesList.innerHTML = `<div class="bundles-empty">Could not load products</div>`;
  }
}

function renderProducts() {
  if (!bundlesList) return;
  if (!state.products.length) {
    bundlesList.innerHTML = `<div class="bundles-empty">No products available</div>`;
    return;
  }
  bundlesList.innerHTML = state.products.map((p) => {
    const key = p.provider || state.activeNetwork;
    const cls = networkClass(key);
    return `
      <div class="bundle-card airtime-card" data-product-id="${escapeHtml(p.id)}">
        ${networkLogoFor(key, { size: 'sm', alt: networkDisplay(key) })}
        <div class="bundle-info">
          <div class="bundle-name">${escapeHtml(p.name || 'Airtime')}</div>
          <div class="bundle-meta">
            <span>${escapeHtml(networkShort(key))}</span>
            <span class="bundle-discount-inline">${USER_DISCOUNT_PCT}% off ₦${USER_DISCOUNT_MIN}+</span>
          </div>
          ${p.description ? `<div class="bundle-desc">${escapeHtml(p.description)}</div>` : ''}
        </div>
        <div class="bundle-right">
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
    card.addEventListener('click', () => {
      const id = card.dataset.productId;
      const product = state.products.find((p) => String(p.id) === String(id));
      if (product) selectProduct(product);
    });
  });
}

function selectProduct(product) {
  state.selectedProduct = product;
  const key = product.provider || state.activeNetwork;
  const cls = networkClass(key);

  if (selectedBundleCard) {
    selectedBundleCard.dataset.provider = cls;
    selectedBundleCard.innerHTML = `
      ${networkLogoFor(key, { size: 'sm', alt: networkDisplay(key) })}
      <div class="sb-info">
        <div class="sb-name">${escapeHtml(product.name || networkDisplay(key) + ' Airtime')}</div>
        <div class="sb-meta">
          <span class="sb-badge sb-${cls}">${escapeHtml(networkShort(key))}</span>
        </div>
      </div>
      <div class="sb-price">₦0.00</div>`;
  }

  if (continueBtn) continueBtn.dataset.provider = cls;

  showStep(stepCheckout);
  loadAndShowRecipients();
}

async function loadAndShowRecipients() {
  const list = await fetchRecentRecipients();
  renderRecentRecipients(list);
}

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
    let raw = e.target.value.replace(/\D/g, '');
    if (raw.length === 1 && /^[789]/.test(raw)) raw = '0' + raw;
    else if (raw.length >= 10 && /^[789]/.test(raw) && !raw.startsWith('0')) raw = '0' + raw;
    if (raw.startsWith('234') && raw.length > 10) raw = '0' + raw.slice(3);

    e.target.value = raw.slice(0, 11);

    clearPhoneError();
    updateSuggestions();

    if (detectTimer) clearTimeout(detectTimer);
    if (e.target.value.length === 11) {
      detectTimer = setTimeout(detectNetworkLive, 250);
    } else {
      state.prefixNetwork = null;
      hideNetworkBadge();
    }
  });

  phoneInput.addEventListener('focus', () => { updateSuggestions(); });
  phoneInput.addEventListener('blur',  () => { setTimeout(hideSuggestions, 180); });
}

function showPhoneError(msg) {
  if (!phoneInput || !phoneError) return;
  phoneInput.classList.add('error');
  phoneError.textContent = msg;
  phoneError.classList.add('show');
  phoneInput.focus();
  phoneInput.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 320, easing: 'ease-out' }
  );
}
function clearPhoneError() {
  if (!phoneInput || !phoneError) return;
  phoneInput.classList.remove('error');
  phoneError.classList.remove('show');
  phoneError.textContent = 'Enter a valid 11-digit phone number';
}

if (amountInput) {
  amountInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
    amountInput.classList.remove('error');
    amountError?.classList.remove('show');

    const v = Number(e.target.value) || 0;
    if (selectedBundleCard) {
      const priceEl = selectedBundleCard.querySelector('.sb-price');
      if (priceEl) {
        if (hasDiscount(v)) {
          const finalPrice = calculateUserPrice(v);
          const saved = calculateDiscountAmount(v);
          priceEl.innerHTML =
            `<span style="text-decoration:line-through;opacity:0.6;font-size:0.85em;">${formatNaira(v)}</span> ` +
            `<strong>${formatNaira(finalPrice)}</strong>` +
            `<div style="font-size:0.75em;color:#0a7d4f;font-weight:600;">You save ${formatNaira(saved)}</div>`;
        } else {
          priceEl.textContent = formatNaira(v);
        }
      }
    }

    quickAmounts?.querySelectorAll('.quick-amt').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.amount) === v);
    });
  });
}

if (quickAmounts) {
  quickAmounts.addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-amt');
    if (!btn) return;
    if (amountInput) {
      amountInput.value = btn.dataset.amount;
      amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

if (pickContactBtn) {
  pickContactBtn.addEventListener('click', async () => {
    if ('contacts' in navigator && 'select' in navigator.contacts) {
      const restore = spinButton(pickContactBtn, 'Opening…');
      try {
        const contacts = await navigator.contacts.select(['tel'], { multiple: false });
        restore();
        if (!contacts || !contacts.length) return;
        const telList = contacts[0].tel || [];
        if (!telList.length) { showPhoneError('That contact has no phone number.'); return; }

        let chosen = telList[0];
        const ngMobile = telList.find((t) =>
          /^(\+?234|0)[789][01]\d{8}$/.test(String(t).replace(/\D/g, ''))
        );
        if (ngMobile) chosen = ngMobile;

        phoneInput.value = normalizeNgPhone(chosen);
        clearPhoneError();
        phoneInput.classList.add('filled');
        setTimeout(() => phoneInput.classList.remove('filled'), 800);
        updateSuggestions();
        detectNetworkLive();
        amountInput?.focus();
      } catch (err) {
        restore();
        if (err?.name === 'AbortError') return;
        showPhoneError('Could not open contacts. Please type the number.');
        phoneInput?.focus();
      }
      return;
    }

    const manual = prompt('Enter phone number manually:\n(Contact picker not supported on this browser)');
    if (manual) {
      const clean = normalizeNgPhone(manual);
      if (/^0\d{10}$/.test(clean)) {
        phoneInput.value = clean;
        clearPhoneError();
        updateSuggestions();
        detectNetworkLive();
        amountInput?.focus();
      } else {
        showPhoneError('That doesn\'t look like a valid Nigerian phone number.');
      }
    }
  });
}

if (continueBtn) {
  continueBtn.addEventListener('click', async () => {
    const phone = normalizeNgPhone(phoneInput.value.trim());
    if (!/^0\d{10}$/.test(phone)) {
      showPhoneError('Enter a valid 11-digit phone number');
      return;
    }

    const amount = Number(amountInput.value);
    if (!amount || amount < USER_MIN_AMOUNT || amount > USER_MAX_AMOUNT) {
      amountInput.classList.add('error');
      amountError?.classList.add('show');
      amountError.textContent =
        `Enter a valid amount (₦${USER_MIN_AMOUNT} – ₦${USER_MAX_AMOUNT.toLocaleString()})`;
      return;
    }

    clearPhoneError();
    hideSuggestions();

    const restore = spinButton(continueBtn, 'Loading…');
    state.phone  = phone;
    state.amount = amount;
    state.prefixNetwork = detectNetworkFromPrefix(phone);

    try {
      const fresh = await fetchWalletBalance();
      if (fresh !== null) state.walletBalance = fresh;
    } catch {}

    setTimeout(() => {
      const cls = networkClass(state.selectedProduct?.provider || state.activeNetwork);
      const userPrice = calculateUserPrice(amount);
      const saved = calculateDiscountAmount(amount);

      if (payNowBtn) payNowBtn.dataset.provider = cls;

      if (payBundleCard) {
        payBundleCard.dataset.provider = cls;
        payBundleCard.innerHTML = `
          ${networkLogoFor(state.activeNetwork, { size: 'sm', alt: networkDisplay(state.activeNetwork) })}
          <div class="sb-info">
            <div class="sb-name">${escapeHtml(state.selectedProduct?.name || networkDisplay(state.activeNetwork) + ' Airtime')}</div>
            <div class="sb-meta">
              <span class="sb-badge sb-${cls}">${escapeHtml(networkShort(state.activeNetwork))}</span>
            </div>
          </div>
          <div class="sb-price-group">
            ${hasDiscount(amount)
              ? `<div class="sb-price" style="text-decoration:line-through;opacity:0.55;font-size:0.85em;">${formatNaira(amount)}</div>
                 <div class="sb-price"><strong>${formatNaira(userPrice)}</strong></div>
                 <div style="font-size:0.75em;color:#0a7d4f;font-weight:600;">Save ${formatNaira(saved)}</div>`
              : `<div class="sb-price">${formatNaira(amount)}</div>`}
          </div>`;
      }

      if (payPhone) payPhone.textContent = phone;
      if (totalAmountEl) totalAmountEl.textContent = formatNaira(userPrice);
      if (walletBalanceEl) walletBalanceEl.textContent = formatNaira(state.walletBalance);

      updatePayButtonState();
      showStep(stepPay);
      restore();
    }, 220);
  });
}

if (fundWalletBtn) {
  fundWalletBtn.addEventListener('click', () => {
    window.location.href = '/fund-wallet.html';
  });
}

$$('.pay-option').forEach((opt) => {
  opt.addEventListener('click', () => {
    if (opt.classList.contains('disabled') || opt.disabled) return;
    $$('.pay-option').forEach((o) => o.classList.remove('active'));
    opt.classList.add('active');
    state.paymentMethod = opt.dataset.method;
  });
});

$('#backToCategories')?.addEventListener('click', function () {
  hideSuggestions();
  const restore = spinButton(this, '');
  setTimeout(() => { showStep(stepCategories); restore(); }, 200);
});
$('#backToBundles')?.addEventListener('click', function () {
  hideSuggestions();
  const restore = spinButton(this, '');
  setTimeout(() => { showStep(stepBundles); restore(); }, 200);
});
$('#backToCheckout')?.addEventListener('click', function () {
  const restore = spinButton(this, '');
  setTimeout(() => { showStep(stepCheckout); restore(); }, 200);
});

if (payNowBtn) {
  payNowBtn.addEventListener('click', async () => {
    const userPrice = calculateUserPrice(state.amount);
    if (state.walletBalance < userPrice) { updatePayButtonState(); return; }
    if (!state.activeNetwork) {
      alert('Please select a network first.');
      showStep(stepCategories);
      return;
    }

    payNowBtn.disabled = true;
    payNowBtn.classList.remove('insufficient');
    payNowBtn.innerHTML = '<span class="spinner-inline"></span> Processing…';

    try {
      const result = await purchaseAirtime({
        network:        state.activeNetwork,
        product_id:     state.selectedProduct?.id,
        phone:          state.phone,
        amount:         state.amount,
        mode:           state.mode,
        payment_method: state.paymentMethod,
      });

      const status = String(result?.status || 'success').toLowerCase();
      const saved  = calculateDiscountAmount(state.amount);
      state.currentReference = result?.reference || null;

      if (status === 'success') {
        state.walletBalance = Math.max(0, state.walletBalance - userPrice);
        localStorage.setItem('walletBalance', String(state.walletBalance));
      } else {
        try {
          const fresh = await fetchWalletBalance();
          if (fresh !== null) {
            state.walletBalance = fresh;
            localStorage.setItem('walletBalance', String(fresh));
          }
        } catch {}
      }

      const remark =
        status === 'success'
          ? (result?.remark || (saved > 0 ? `Success · You saved ${formatNaira(saved)}` : 'Success'))
          : (result?.remark || 'Processing — you will be notified once confirmed');

      showPurchaseUpdate({
        status,
        product:   result?.product || `${state.activeNetwork}-airtime`,
        amount:    userPrice,
        remark,
        recipient: state.phone,
        reference: result?.reference || result?.id || '—',
      });

      if (status === 'processing' || status === 'pending') {
        if (state.currentReference) startPolling(state.currentReference);
      }

      payNowBtn.textContent = 'Pay Now';
      updatePayButtonState();
    } catch (err) {
      console.error('[airtime] purchase:', err);

      if (err.code === 'INSUFFICIENT_BALANCE') {
        const bal = Number(err.data?.balance ?? state.walletBalance);
        state.walletBalance = bal;
        if (walletBalanceEl) walletBalanceEl.textContent = formatNaira(bal);
        updatePayButtonState();
        payNowBtn.textContent = 'Pay Now';
        return;
      }

      if (err.code === 'NETWORK_MISMATCH') {
        payNowBtn.textContent = 'Pay Now';
        updatePayButtonState();
        showPurchaseUpdate({
          status:    'failed',
          product:   `${state.activeNetwork}-airtime`,
          amount:    userPrice,
          remark:    sanitizeRemark(err.data?.remark || err.message) ||
                     `This number doesn't match ${networkDisplay(state.activeNetwork)}. Please select the correct network.`,
          recipient: state.phone,
          reference: '—',
        });
        return;
      }

      const wasRefunded = !!err.data?.refunded;
      const refundAmt   = Number(err.data?.refunded_amount ?? userPrice);
      let remark;
      if (wasRefunded) {
        remark = `${sanitizeRemark(err.message) || 'Purchase could not be completed.'} ${formatNaira(refundAmt)} refunded to your wallet.`;
      } else {
        remark = sanitizeRemark(err.message) || 'Purchase failed. Please try again.';
      }

      showPurchaseUpdate({
        status:    'failed',
        product:   `${state.activeNetwork}-airtime`,
        amount:    userPrice,
        remark,
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

      payNowBtn.textContent = 'Pay Now';
      updatePayButtonState();
    }
  });
}

/* ============================================================
   INLINE SPINNER STYLE
   ============================================================ */
(function injectSpinnerStyle() {
  if (document.getElementById('airtime-spinner-style')) return;
  const style = document.createElement('style');
  style.id = 'airtime-spinner-style';
  style.textContent = `
    .spinner-dark {
      display: inline-block;
      width: 16px; height: 16px;
      border-radius: 50%;
      border: 2.5px solid rgba(10, 69, 52, 0.2);
      border-top-color: #0a4534;
      animation: airtimeSpin 0.65s linear infinite;
      vertical-align: middle;
    }
    .spinner-inline {
      display: inline-block;
      width: 15px; height: 15px;
      border-radius: 50%;
      border: 2.5px solid rgba(255, 255, 255, 0.35);
      border-top-color: #ffffff;
      animation: airtimeSpin 0.65s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    .btn-primary[data-provider="mtn"] .spinner-inline {
      border-color: rgba(10, 10, 10, 0.25);
      border-top-color: #0a0a0a;
    }
    @keyframes airtimeSpin { to { transform: rotate(360deg); } }
    #pmRemark {
      font-size: 13px;
      font-weight: 500;
      color: #0f172a;
      line-height: 1.5;
      word-break: break-word;
    }
  `;
  document.head.appendChild(style);
})();

/* ============================================================
   BOOT
   ============================================================ */
async function init() {
  if (!getToken()) { redirectToLogin(); return; }

  try {
    const [user, networks] = await Promise.all([fetchMe(), fetchNetworks()]);

    if (user) {
      state.walletBalance = Number(user.balance ?? user.wallet?.balance ?? 0);
    }
    try {
      const fresh = await fetchWalletBalance();
      if (fresh !== null) state.walletBalance = fresh;
    } catch {}

    state.networks = networks.length
      ? networks
      : [
          { key: 'mtn', products: 1 },
          { key: 'airtel', products: 1 },
          { key: 'glo', products: 1 },
          { key: 't2', products: 1 },
        ];

    renderCategories();
  } catch (err) {
    console.error('[airtime] init:', err);
    if (categoryList) {
      categoryList.innerHTML = `<div class="bundles-empty">Could not load networks</div>`;
    }
  }
}
init();
