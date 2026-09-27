// frontend/js/home.js
// ============================================================
// Dashboard — clean, no service-card handling (inline in HTML)
// Handles: transactions, modal, balance toggle, auto-refresh
// ============================================================

const API_BASE = '/api/v1';

try {
  const _t = localStorage.getItem('token') || sessionStorage.getItem('token');
  if (_t) sessionStorage.setItem('lastPath', location.pathname);
} catch {}

/* ============================================================
   AUTH
   ============================================================ */
function getStore() {
  return localStorage.getItem('token') ? localStorage : sessionStorage;
}
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
   TOAST
   ============================================================ */
const TOAST_ICONS = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  error:   `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M6 18L18 6"/></svg>`,
  info:    `<svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>`,
};

let toastHost = null;
function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = document.createElement('div');
  toastHost.className = 'toast-host';
  document.body.appendChild(toastHost);
  return toastHost;
}

function showToast(message, type = 'info', duration = 2200) {
  try {
    const host = ensureToastHost();
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span>${escapeHtml(message)}</span>`;
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    const kill = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 260); };
    const timer = setTimeout(kill, duration);
    t.addEventListener('click', () => { clearTimeout(timer); kill(); });
  } catch {}
}
window.showToast = showToast;

/* ============================================================
   FORMATTERS
   ============================================================ */
function formatNaira(n) {
  const num = Number(n || 0);
  return '₦ ' + num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatNairaCompact(n) {
  const num = Number(n || 0);
  return '₦' + num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  if (hr < 24) return `${hr} hr ago`;
  if (day < 7) return `${day} day${day > 1 ? 's' : ''} ago`;
  return d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateTimeFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
   ICONS
   ============================================================ */
const ICONS = {
  data: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  airtime: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  bills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>`,
  cables: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3l4 4 4-4"/></svg>`,
  exam: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>`,
  funding: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  refund: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>`,
  transfer: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>`,
  withdrawal: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16m8-8l-8 8-8-8"/></svg>`,
  check: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  x: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18L18 6M6 6l12 12"/></svg>`,
  clock: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  undo: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>`,
  default: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
};

/* ============================================================
   FRIENDLY TITLE — "MTN airtime", "Airtel data", etc.
   ============================================================ */
function friendlyTitle(tx) {
  const type    = String(tx.type || tx.category || '').toLowerCase();
  const service = String(tx.service || '').toLowerCase();
  const meta    = tx.metadata || {};
  const desc    = String(tx.description || '').trim();

  const haystack = [
    tx.network, meta.network_name, meta.network,
    service, desc,
  ].join(' ').toLowerCase();

  let net = '';
  if (haystack.includes('mtn')) net = 'MTN';
  else if (haystack.includes('airtel')) net = 'Airtel';
  else if (haystack.includes('glo')) net = 'Glo';
  else if (haystack.includes('9mobile') || haystack.includes('etisalat')) net = '9mobile';

  let product = '';
  if (type.includes('airtime') || service.includes('airtime') || desc.toLowerCase().includes('airtime')) {
    product = 'airtime';
  } else if (type.includes('data') || service.includes('data') || desc.toLowerCase().includes('data')) {
    product = 'data';
  } else if (type.includes('electric') || desc.toLowerCase().includes('electric')) {
    product = 'electricity';
  } else if (type.includes('cable') || type.includes('tv') ||
             desc.toLowerCase().includes('cable') || desc.toLowerCase().includes('tv') ||
             service.includes('cable') || service.includes('tv')) {
    product = 'tv subscription';
  } else if (type.includes('exam') || service.includes('exam') || desc.toLowerCase().includes('exam')) {
    product = 'exam pin';
  } else if (type.includes('wallet_topup') || type.includes('fund') || type.includes('deposit')) {
    product = 'wallet funding';
  } else if (type.includes('refund')) {
    product = 'refund';
  } else if (type.includes('transfer') || type.includes('send')) {
    product = 'transfer';
  } else if (type.includes('withdraw')) {
    product = 'withdrawal';
  } else if (type.includes('bonus')) {
    product = 'bonus';
  }

  if (product) {
    if (net && (product === 'airtime' || product === 'data')) {
      return `${net} ${product}`;
    }
    return product.charAt(0).toUpperCase() + product.slice(1);
  }

  if (desc && desc.length <= 40) return desc;
  return 'Transaction';
}

function statusInfo(tx) {
  const s = String(tx.status || '').toLowerCase();
  if (s === 'success' || s === 'successful' || s === 'completed') return { label: 'Successful', cls: 'success' };
  if (s === 'pending' || s === 'processing' || s === 'in_progress' || s === 'submitted') return { label: 'Processing', cls: 'pending' };
  if (s === 'failed' || s === 'failure' || s === 'rejected') return { label: 'Failed', cls: 'failed' };
  if (s === 'refunded') return { label: 'Refunded', cls: 'refunded' };
  return { label: 'Processing', cls: 'pending' };
}

function txIconMarkup(tx) {
  const type    = String(tx.type || tx.category || '').toLowerCase();
  const service = String(tx.service || '').toLowerCase();
  let cls = 'default';
  let svg = ICONS.default;

  if (type.includes('vtu') && service.includes('airtime'))  { cls = 'airtime';    svg = ICONS.airtime; }
  else if (type.includes('vtu') && service.includes('data')){ cls = 'data';       svg = ICONS.data; }
  else if (type.includes('vtu') && service.includes('electric')) { cls = 'electricity'; svg = ICONS.bills; }
  else if (type.includes('vtu') && service.includes('cable')){ cls = 'tv';         svg = ICONS.cables; }
  else if (type.includes('vtu') && service.includes('exam')){ cls = 'exam';        svg = ICONS.exam; }
  else if (type.includes('airtime'))  { cls = 'airtime';    svg = ICONS.airtime; }
  else if (type.includes('data'))     { cls = 'data';       svg = ICONS.data; }
  else if (type.includes('electric')) { cls = 'electricity';svg = ICONS.bills; }
  else if (type.includes('cable') || type.includes('tv')) { cls = 'tv'; svg = ICONS.cables; }
  else if (type.includes('exam'))     { cls = 'exam';       svg = ICONS.exam; }
  else if (type.includes('wallet_topup') || type.includes('fund') || type.includes('deposit')) { cls = 'funding'; svg = ICONS.funding; }
  else if (type.includes('refund')) { cls = 'funding'; svg = ICONS.refund; }
  else if (type.includes('transfer') || type.includes('send')) { cls = 'transfer'; svg = ICONS.transfer; }
  else if (type.includes('withdraw')) { cls = 'withdrawal'; svg = ICONS.withdrawal; }

  return `<div class="tx-icon ${cls}">${svg}</div>`;
}

function amountClass(tx) {
  const status    = String(tx.status || '').toLowerCase();
  const direction = String(tx.direction || '').toUpperCase();
  const type      = String(tx.type || '').toLowerCase();

  if (status === 'failed' || status === 'failure' || status === 'rejected') return 'failed';
  if (status === 'refunded') return 'credit';
  if (status === 'pending' || status === 'processing' || status === 'in_progress' || status === 'submitted') return 'processing';

  let isCredit = false;
  if (direction === 'CREDIT') isCredit = true;
  else if (direction === 'DEBIT') isCredit = false;
  else {
    isCredit =
      type.includes('topup') || type.includes('fund') || type.includes('refund') ||
      type.includes('bonus') || type.includes('deposit') || type.includes('credit') ||
      type.includes('received');
  }
  return isCredit ? 'credit' : 'default';
}

function txAmountText(tx) {
  return formatNairaCompact(Math.abs(Number(tx.amount || 0)));
}

/* ============================================================
   BALANCE BEFORE / AFTER
   ============================================================ */
function resolveBalanceBefore(tx) {
  const meta = tx.metadata || {};
  if (meta.balance_before != null) return Number(meta.balance_before);
  if (meta.balanceBefore != null)  return Number(meta.balanceBefore);
  const amt = Math.abs(Number(tx.amount || 0));
  const isCredit = amountClass(tx) === 'credit';
  if (tx.balance_before != null) return Number(tx.balance_before);
  if (meta.balance_after != null) {
    const after = Number(meta.balance_after);
    return isCredit ? after - amt : after + amt;
  }
  const currentBalance = currentUser ? userBalanceOf(currentUser) : null;
  if (currentBalance != null) return isCredit ? currentBalance - amt : currentBalance + amt;
  return null;
}

function resolveBalanceAfter(tx) {
  const meta = tx.metadata || {};
  if (meta.balance_after != null) return Number(meta.balance_after);
  if (meta.balanceAfter != null)  return Number(meta.balanceAfter);
  if (tx.balance_after != null)   return Number(tx.balance_after);
  const before = resolveBalanceBefore(tx);
  if (before != null) {
    const amt = Math.abs(Number(tx.amount || 0));
    const isCredit = amountClass(tx) === 'credit';
    return isCredit ? before + amt : before - amt;
  }
  return null;
}

/* ============================================================
   FRIENDLY REMARK
   ============================================================ */
function friendlyRemark(tx) {
  const status = String(tx.status || '').toLowerCase();
  const meta   = tx.metadata || {};
  const reason = String(meta.reason || meta.fail_reason || tx.remark || '').toLowerCase();
  const desc   = String(tx.description || '').trim();
  const isInternal = /insufficient wallet balance|provider fail|no working status|datashop|upstream|internal|timeout/i.test(reason + ' ' + desc);

  if (status === 'success' || status === 'successful' || status === 'completed') return desc || 'Transaction completed successfully.';
  if (status === 'failed' || status === 'failure' || status === 'rejected') {
    if (isInternal) return 'This transaction could not be completed. If you were debited, the amount will be reversed shortly.';
    if (reason.includes('insufficient'))      return 'Insufficient wallet balance.';
    if (reason.includes('invalid phone'))     return 'The phone number entered is invalid.';
    if (reason.includes('network'))           return 'The network is temporarily unavailable. Please try again.';
    if (reason.includes('limit'))             return 'This transaction exceeded a limit. Try a lower amount.';
    return 'We could not complete this transaction. Please try again.';
  }
  if (status === 'refunded') return 'This transaction was reversed and refunded to your wallet.';
  if (status === 'pending' || status === 'processing') return 'We\'re still processing this transaction. Please check back shortly.';
  return desc || 'Transaction processed.';
}

/* ============================================================
   DOM REFERENCES
   ============================================================ */
const elName      = document.getElementById('userName');
const elGreetTime = document.getElementById('greetTime');
const elBalance   = document.getElementById('balance');
const btnToggle   = document.getElementById('toggleBalance');
const eyeOpen     = document.getElementById('eyeOpen');
const eyeClosed   = document.getElementById('eyeClosed');
const txSkeleton  = document.getElementById('txSkeleton');
const txReal      = document.getElementById('txReal');
const txEmpty     = document.getElementById('txEmpty');

const txModal          = document.getElementById('txModal');
const txmClose         = document.getElementById('txmClose');
const txmHero          = document.getElementById('txmHero');
const txmStatus        = document.getElementById('txmStatus');
const txmTitle         = document.getElementById('txmTitle');
const txmAmount        = document.getElementById('txmAmount');
const txmRecipient     = document.getElementById('txmRecipient');
const txmReference     = document.getElementById('txmReference');
const txmDate          = document.getElementById('txmDate');
const txmType          = document.getElementById('txmType');
const txmNetwork       = document.getElementById('txmNetwork');
const txmBalance       = document.getElementById('txmBalance');
const txmBalanceBefore = document.getElementById('txmBalanceBefore');
const txmRemark        = document.getElementById('txmRemark');
const txmCopy          = document.getElementById('txmCopy');
const txmShare         = document.getElementById('txmShare');
const txmPrint         = document.getElementById('txmPrint');
const txmDone          = document.getElementById('txmDone');

let currentTx = null;
let currentUser = null;

const REFRESH_INTERVAL_MS = 30_000;
let refreshTimer = null;
let isRefreshing = false;
let lastFingerprint = '';

/* ============================================================
   RENDER TRANSACTIONS
   ============================================================ */
function renderTransactions(txs) {
  if (!txSkeleton || !txReal || !txEmpty) return;
  txSkeleton.classList.add('hidden');

  if (!txs || !txs.length) {
    txEmpty.classList.remove('hidden');
    txReal.classList.add('hidden');
    txReal.innerHTML = '';
    document.body.classList.add('short-page');
    return;
  }

  txEmpty.classList.add('hidden');
  document.body.classList.remove('short-page');

  txReal.innerHTML = txs.map((tx, idx) => {
    const title  = friendlyTitle(tx);
    const when   = formatDate(tx.created_at || tx.createdAt || tx.date);
    const status = statusInfo(tx);
    const amtCls = amountClass(tx);
    const amtTxt = txAmountText(tx);
    return `
      <div class="tx-item" data-tx-idx="${idx}" role="button" tabindex="0">
        ${txIconMarkup(tx)}
        <div class="tx-body">
          <div class="tx-title">${escapeHtml(title)}</div>
          <div class="tx-meta">
            <span class="tx-when">${escapeHtml(when)}</span>
            <span class="tx-status ${status.cls}">${escapeHtml(status.label)}</span>
          </div>
        </div>
        <div class="tx-amount ${amtCls}">${escapeHtml(amtTxt)}</div>
      </div>
    `;
  }).join('');

  txReal.classList.remove('hidden');

  txReal.querySelectorAll('.tx-item').forEach((row) => {
    const idx = Number(row.dataset.txIdx);
    const tx = txs[idx];
    if (!tx) return;
    row.addEventListener('click', () => openTxModal(tx));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTxModal(tx);
      }
    });
  });
}

/* ============================================================
   MODAL
   ============================================================ */
function openTxModal(tx) {
  if (!txModal) return;
  currentTx = tx;

  const status = statusInfo(tx);
  const title  = friendlyTitle(tx);
  const amt    = formatNaira(Math.abs(Number(tx.amount || 0)));
  const meta   = tx.metadata || {};

  const heroClass =
    status.cls === 'success' ? 'txm-success' :
    status.cls === 'failed'  ? 'txm-failed'  :
    status.cls === 'refunded'? 'txm-refunded':
    'txm-processing';
  if (txmHero) {
    txmHero.classList.remove('txm-success', 'txm-failed', 'txm-processing', 'txm-refunded');
    txmHero.classList.add(heroClass);
  }

  const iconSvg =
    status.cls === 'success' ? ICONS.check :
    status.cls === 'failed'  ? ICONS.x :
    status.cls === 'refunded'? ICONS.undo :
    ICONS.clock;
  const heroIcon = txmHero?.querySelector('.txm-hero-icon');
  if (heroIcon) heroIcon.innerHTML = iconSvg;

  if (txmStatus) { txmStatus.textContent = status.label; txmStatus.className = `txm-status ${status.cls}`; }
  if (txmTitle)  txmTitle.textContent  = title;
  if (txmAmount) txmAmount.textContent = amt;

  if (txmRecipient) txmRecipient.textContent = meta.phone || '—';
  if (txmReference) txmReference.textContent = tx.reference || '—';
  if (txmDate)      txmDate.textContent      = formatDateTimeFull(tx.created_at || tx.createdAt);
  if (txmType)      txmType.textContent      = title;
  if (txmNetwork)   txmNetwork.textContent   = meta.network_name || meta.network || '—';

  if (txmBalanceBefore) {
    const before = resolveBalanceBefore(tx);
    txmBalanceBefore.textContent = before != null ? formatNaira(before) : '—';
  }
  if (txmBalance) {
    const after = resolveBalanceAfter(tx);
    txmBalance.textContent = after != null ? formatNaira(after) : '—';
  }
  if (txmRemark) txmRemark.textContent = friendlyRemark(tx);

  txModal.classList.remove('hidden');
  txModal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => txModal.classList.add('show'));
  document.body.style.overflow = 'hidden';
}

function closeTxModal() {
  if (!txModal) return;
  txModal.classList.remove('show');
  document.body.style.overflow = '';
  setTimeout(() => {
    txModal.classList.add('hidden');
    txModal.setAttribute('aria-hidden', 'true');
    currentTx = null;
  }, 240);
}

if (txmClose) txmClose.addEventListener('click', closeTxModal);
if (txmDone)  txmDone.addEventListener('click', () => {
  txmDone.classList.add('btn-loading');
  const lbl = document.createElement('span');
  lbl.className = 'btn-loading-label';
  lbl.textContent = 'Closing…';
  txmDone.appendChild(lbl);
  setTimeout(() => closeTxModal(), 220);
});
if (txModal) {
  txModal.addEventListener('click', (e) => { if (e.target === txModal) closeTxModal(); });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && txModal && !txModal.classList.contains('hidden')) closeTxModal();
});

if (txmCopy) {
  txmCopy.addEventListener('click', async () => {
    if (!currentTx?.reference) { showToast('No reference to copy', 'error'); return; }
    try {
      await navigator.clipboard.writeText(currentTx.reference);
      showToast('Reference copied', 'success');
    } catch { showToast('Could not copy', 'error'); }
  });
}

if (txmShare) {
  txmShare.addEventListener('click', () => {
    if (!currentTx) return;
    const meta   = currentTx.metadata || {};
    const title  = friendlyTitle(currentTx);
    const amount = formatNaira(Math.abs(Number(currentTx.amount || 0)));
    const status = statusInfo(currentTx).label;
    const before = resolveBalanceBefore(currentTx);
    const after  = resolveBalanceAfter(currentTx);
    const holder = resolveDisplayName(currentUser) || '—';
    const remark = friendlyRemark(currentTx);

    const text =
      `Shatova Receipt\n─────────────\n` +
      `Account: ${holder}\n` +
      `${title}\nAmount: ${amount}\nStatus: ${status}\n` +
      `Reference: ${currentTx.reference || '—'}\n` +
      `Date: ${formatDateTimeFull(currentTx.created_at || currentTx.createdAt)}\n` +
      `Balance Before: ${before != null ? formatNaira(before) : '—'}\n` +
      `Balance After: ${after != null ? formatNaira(after) : '—'}\n` +
      `Remark: ${remark}`;

    if (navigator.share) {
      navigator.share({ title: 'Shatova Receipt', text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Receipt copied to clipboard', 'success'))
        .catch(() => showToast('Could not share', 'error'));
    }
  });
}

if (txmPrint) {
  txmPrint.addEventListener('click', () => {
    if (!currentTx) return;
    const title  = friendlyTitle(currentTx);
    const amount = formatNaira(Math.abs(Number(currentTx.amount || 0)));
    const status = statusInfo(currentTx).label;
    const meta   = currentTx.metadata || {};
    const before = resolveBalanceBefore(currentTx);
    const after  = resolveBalanceAfter(currentTx);
    const holder = resolveDisplayName(currentUser) || '—';
    const remark = friendlyRemark(currentTx);

    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) { showToast('Popup blocked', 'error'); return; }

    w.document.write(`
      <!DOCTYPE html><html><head><title>Shatova Receipt</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 24px; color: #0f172a; max-width: 340px; margin: 0 auto; }
        .head { text-align: center; padding-bottom: 16px; border-bottom: 2px dashed #e2e8f0; margin-bottom: 16px; }
        .brand { font-size: 20px; font-weight: 800; color: #0a4534; }
        .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
        .account { font-size: 13px; font-weight: 700; color: #0f172a; margin-top: 10px; }
        .amount { font-size: 26px; font-weight: 800; margin: 16px 0 4px; text-align: center; }
        .status { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #047857; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
        .row:last-child { border-bottom: none; }
        .label { color: #64748b; font-weight: 500; }
        .value { color: #0f172a; font-weight: 700; text-align: right; max-width: 60%; word-break: break-word; }
        .remark { margin-top: 16px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 11.5px; line-height: 1.5; color: #334155; }
        .remark-label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 2px dashed #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
      </style></head><body>
        <div class="head">
          <div class="brand">SHATOVA</div>
          <div class="sub">Transaction Receipt</div>
          <div class="account">${escapeHtml(holder)}</div>
        </div>
        <div class="amount">${escapeHtml(amount)}</div><div class="status">${escapeHtml(status)}</div>
        <div class="row"><span class="label">Type</span><span class="value">${escapeHtml(title)}</span></div>
        <div class="row"><span class="label">Recipient</span><span class="value">${escapeHtml(meta.phone || '—')}</span></div>
        <div class="row"><span class="label">Network</span><span class="value">${escapeHtml(meta.network_name || meta.network || '—')}</span></div>
        <div class="row"><span class="label">Reference</span><span class="value">${escapeHtml(currentTx.reference || '—')}</span></div>
        <div class="row"><span class="label">Date</span><span class="value">${escapeHtml(formatDateTimeFull(currentTx.created_at || currentTx.createdAt))}</span></div>
        <div class="row"><span class="label">Balance Before</span><span class="value">${escapeHtml(before != null ? formatNaira(before) : '—')}</span></div>
        <div class="row"><span class="label">Balance After</span><span class="value">${escapeHtml(after != null ? formatNaira(after) : '—')}</span></div>
        <div class="remark">
          <div class="remark-label">Remark</div>
          ${escapeHtml(remark)}
        </div>
        <div class="footer">Thank you for using Shatova 💚<br>support@shatova.com</div>
        <script>window.onload = () => { setTimeout(() => window.print(), 300); };<\/script>
      </body></html>
    `);
    w.document.close();
  });
}

/* ============================================================
   GREETING
   ============================================================ */
function setGreeting() {
  const h = new Date().getHours();
  let g = 'Good Morning';
  if (h >= 12 && h < 17) g = 'Good Afternoon';
  else if (h >= 17 || h < 5) g = 'Good Evening';
  if (elGreetTime) elGreetTime.textContent = g;
}

/* ============================================================
   BALANCE VISIBILITY
   ============================================================ */
let balanceHidden = false;
let realBalanceText = '₦ 0.00';

function applyBalanceVisibility() {
  if (!elBalance) return;
  elBalance.textContent = balanceHidden ? '₦ ••••••' : realBalanceText;
  if (eyeOpen && eyeClosed) {
    eyeOpen.classList.toggle('hidden', balanceHidden);
    eyeClosed.classList.toggle('hidden', !balanceHidden);
  }
}

if (btnToggle) {
  btnToggle.addEventListener('click', () => {
    balanceHidden = !balanceHidden;
    applyBalanceVisibility();
  });
}

/* ============================================================
   USER EXTRACTORS
   ============================================================ */
function extractUser(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.data && typeof json.data === 'object') {
    if (json.data.user && typeof json.data.user === 'object') return json.data.user;
    if (json.data.id || json.data.email || json.data.name) return json.data;
  }
  if (json.user && typeof json.user === 'object') return json.user;
  if (json.id || json.email || json.name) return json;
  return null;
}
function resolveDisplayName(user) {
  if (!user) return null;
  const candidates = [
    user.name, user.fullName, user.full_name,
    user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null,
    user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : null,
    user.firstName, user.first_name, user.username,
    user.email ? user.email.split('@')[0] : null,
  ];
  for (const c of candidates) {
    if (c && String(c).trim().length > 0) return String(c).trim();
  }
  return null;
}
function userBalanceOf(user) {
  return Number(
    user?.balance ?? user?.wallet?.balance ?? user?.wallet_balance ?? user?.walletBalance ?? 0
  );
}

/* ============================================================
   CACHE RENDER
   ============================================================ */
function renderFromCache() {
  try {
    const store = getStore();
    const cachedUser = JSON.parse(store.getItem('user') || 'null');
    const cachedTx   = JSON.parse(store.getItem('recentTransactions') || 'null');
    let painted = false;

    if (cachedUser) {
      currentUser = cachedUser;
      const name = resolveDisplayName(cachedUser);
      if (name && elName) elName.textContent = `Hi, ${name.split(/\s+/)[0]} 👋`;
      else if (elName) {
        const fallback = cachedUser.phone || (cachedUser.email ? cachedUser.email.split('@')[0] : null) || 'there';
        elName.textContent = `Hi, ${fallback} 👋`;
      }
      realBalanceText = formatNaira(userBalanceOf(cachedUser));
      applyBalanceVisibility();
      painted = true;
    }

    if (Array.isArray(cachedTx) && cachedTx.length) {
      renderTransactions(cachedTx);
      painted = true;
    }
    return painted;
  } catch { return false; }
}

function saveUserToCache(user) {
  try { getStore().setItem('user', JSON.stringify(user)); } catch {}
}
function saveTxToCache(txs) {
  try { getStore().setItem('recentTransactions', JSON.stringify(txs.slice(0, 5))); } catch {}
}

/* ============================================================
   API
   ============================================================ */
async function loadMe() {
  const res = await fetch(`${API_BASE}/auth/me`, {
    method: 'GET',
    headers: authHeaders(),
    cache: 'default',
  });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return null; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Could not load profile');
  return extractUser(json);
}

async function loadRecentTransactions(limit = 5) {
  const res = await fetch(`${API_BASE}/wallet/transactions?limit=${limit}`, {
    headers: authHeaders(),
    cache: 'default',
  });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return null; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) return null;
  const list =
    json.data?.transactions || json.data?.items || json.transactions || json.items ||
    (Array.isArray(json.data) ? json.data : []) || [];
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

/* ============================================================
   APPLY USER
   ============================================================ */
function applyUser(user) {
  if (!user) return;
  currentUser = user;
  const fullName = resolveDisplayName(user);
  if (elName) {
    if (fullName) elName.textContent = `Hi, ${fullName.split(/\s+/)[0]} 👋`;
    else {
      const fallback = user.phone || (user.email ? user.email.split('@')[0] : null) || 'there';
      elName.textContent = `Hi, ${fallback} 👋`;
    }
  }
  realBalanceText = formatNaira(userBalanceOf(user));
  applyBalanceVisibility();
  saveUserToCache(user);
}

/* ============================================================
   FINGERPRINT
   ============================================================ */
function computeFingerprint(user, txs) {
  const balance = user ? userBalanceOf(user) : 0;
  const latest  = txs && txs.length ? (txs[0]?.id ?? txs[0]?.reference ?? '') : '';
  const count   = txs ? txs.length : 0;
  return `${user?.id || ''}|${balance}|${latest}|${count}`;
}

/* ============================================================
   SILENT REFRESH
   ============================================================ */
async function silentRefresh() {
  if (isRefreshing) return;
  if (document.hidden) return;
  if (txModal && !txModal.classList.contains('hidden')) return;
  if (!getToken()) return;

  isRefreshing = true;
  if (elBalance) elBalance.classList.add('refreshing');

  try {
    const [user, txs] = await Promise.all([
      loadMe().catch(() => null),
      loadRecentTransactions(5).catch(() => null),
    ]);
    const fp = computeFingerprint(user, txs);
    if (user) applyUser(user);
    if (txs !== null && fp !== lastFingerprint) {
      lastFingerprint = fp;
      saveTxToCache(txs);
      renderTransactions(txs);
    }
  } catch (err) {
    console.warn('[home] silent refresh failed:', err?.message);
  } finally {
    if (elBalance) elBalance.classList.remove('refreshing');
    isRefreshing = false;
  }
}

/* ============================================================
   TIMER
   ============================================================ */
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(silentRefresh, REFRESH_INTERVAL_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else { silentRefresh(); startAutoRefresh(); }
});
window.addEventListener('beforeunload', stopAutoRefresh);

/* ============================================================
   BOOT
   ============================================================ */
async function init() {
  setGreeting();
  if (!getToken()) { redirectToLogin(); return; }

  const hadCache = renderFromCache();

  if (!hadCache) {
    if (txSkeleton) txSkeleton.classList.remove('hidden');
    if (txReal) txReal.classList.add('hidden');
    if (txEmpty) txEmpty.classList.add('hidden');
  }

  startAutoRefresh();

  try {
    const [userR, txsR] = await Promise.allSettled([
      loadMe(),
      loadRecentTransactions(5),
    ]);
    const user = userR.status === 'fulfilled' ? userR.value : null;
    const txs  = txsR.status  === 'fulfilled' ? txsR.value  : null;

    if (user) applyUser(user);
    if (txs !== null) {
      lastFingerprint = computeFingerprint(user, txs);
      saveTxToCache(txs);
      renderTransactions(txs);
    } else if (!hadCache) {
      renderTransactions([]);
    }
  } catch (err) {
    console.error('[home] init failed:', err);
    if (txSkeleton) txSkeleton.classList.add('hidden');
    if (!hadCache && txEmpty) txEmpty.classList.remove('hidden');
  }
}

init();