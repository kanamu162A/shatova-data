// frontend/js/transactions.js
// ============================================================
// Shatova — Transaction History
//   ⭐ Refunded filter · Clean icons · Black amounts · No signs
// ============================================================

const API_BASE = window.API_BASE;
const PAGE_SIZE = 20;

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
  allTransactions: [],
  filtered: [],
  search: '',
  currentPage: 1,
  totalPages: 1,
  loading: false,
  filters: {
    category: 'all',    // all | deposits | withdrawals | refunded | transfers
    status: 'all',      // all | success | processing | failed
  },
};

const $  = (s) => document.querySelector(s);

const txCount         = $('#txCount');
const txReal          = $('#txReal');
const txSkeleton      = $('#txSkeleton');
const txEmpty         = $('#txEmpty');
const txEmptyTitle    = $('#txEmptyTitle');
const txEmptyText     = $('#txEmptyText');

const txSearchInput   = $('#txSearchInput');
const txSearchClear   = $('#txSearchClear');
const txStatusChips   = $('#txStatusChips');

const typeDropdownBtn   = $('#typeDropdownBtn');
const typeDropdownLabel = $('#typeDropdownLabel');

const txFilterFab     = $('#txFilterFab');
const txFilterBadge   = $('#txFilterBadge');

const filterSheet     = $('#filterSheet');
const filterClose     = $('#filterClose');
const filterBody      = $('#filterBody');
const filterReset     = $('#filterReset');
const filterApply     = $('#filterApply');

const txPagination    = $('#txPagination');
const pgNumbers       = $('#pgNumbers');
const pgPrev          = $('#pgPrev');
const pgNext          = $('#pgNext');

/* Modal */
const txModal      = $('#txModal');
const txmClose     = $('#txmClose');
const txmHero      = $('#txmHero');
const txmHeroIcon  = $('#txmHeroIcon');
const txmStatus    = $('#txmStatus');
const txmTitle     = $('#txmTitle');
const txmAmount    = $('#txmAmount');
const txmRecipient = $('#txmRecipient');
const txmReference = $('#txmReference');
const txmDate      = $('#txmDate');
const txmType      = $('#txmType');
const txmNetwork   = $('#txmNetwork');
const txmRemark    = $('#txmRemark');
const txmCopy      = $('#txmCopy');
const txmShare     = $('#txmShare');
const txmPrint     = $('#txmPrint');
const txmDone      = $('#txmDone');

let currentTx = null;
let draftCategory = 'all';

/* FORMATTERS */
function formatNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function formatDateTimeFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-NG', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}
function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);

  if (min < 1)  return 'Just now';
  if (min < 60) return `${min} min ago`;
  if (hr < 24)  return `${hr} hr ago`;
  if (day === 1) return 'Yesterday';
  if (day < 7)  return `${day} days ago`;
  return d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ICONS — clean, no yellow */
const ICONS = {
  /* Airtime — purple phone */
  airtime: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  /* Data — blue wifi */
  data: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  /* Electricity — green bolt */
  electricity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
  /* Cable — indigo monitor */
  cable: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3l4 4 4-4"/></svg>`,
  /* Exam — indigo book */
  exam: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>`,
  /* Deposit — green down arrow */
  deposit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
  /* Withdraw — red up arrow */
  withdraw: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  /* Transfer — blue arrows */
  transfer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>`,
  /* Refund — indigo undo */
  refund: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>`,
  /* Generic */
  generic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,

  /* Modal hero icons */
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18L18 6M6 6l12 12"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>`,
};

/* CLASSIFY — categories */
function classify(tx) {
  const status  = String(tx.status || '').toLowerCase();
  const type    = String(tx.type || '').toLowerCase();
  const service = String(tx.service || '').toLowerCase();
  const dir     = String(tx.direction || '').toUpperCase();

  /* Refunded — highest priority */
  if (status === 'refunded' || type.includes('refund')) return 'refunded';

  /* Deposits */
  if (type.includes('wallet_topup') || type.includes('topup') ||
      type.includes('fund') || type.includes('deposit') ||
      type.includes('credit') || type.includes('bonus') ||
      (dir === 'CREDIT')) {
    return 'deposits';
  }

  /* Withdrawals */
  if (type.includes('withdraw') || type.includes('cash_out')) return 'withdrawals';

  /* Transfers */
  if (type.includes('transfer') || type.includes('send')) return 'transfers';

  /* Everything else = orders (not filtered directly, just shown in all) */
  return 'orders';
}

/* ICON by service (not category) — so it matches the transaction type */
function txIconMarkup(tx) {
  const service = String(tx.service || '').toLowerCase();
  const type    = String(tx.type || '').toLowerCase();
  const status  = String(tx.status || '').toLowerCase();

  /* Refunded → undo icon */
  if (status === 'refunded' || type.includes('refund')) {
    return `<div class="tx-icon tx-icon-refund">${ICONS.refund}</div>`;
  }

  /* Airtime */
  if (service.includes('airtime') || type.includes('airtime')) {
    return `<div class="tx-icon tx-icon-airtime">${ICONS.airtime}</div>`;
  }
  /* Data */
  if (service.includes('data') || type.includes('data')) {
    return `<div class="tx-icon tx-icon-data">${ICONS.data}</div>`;
  }
  /* Electricity / Bills */
  if (service.includes('electric') || type.includes('electric') ||
      service.includes('bill') || type.includes('bill')) {
    return `<div class="tx-icon tx-icon-electricity">${ICONS.electricity}</div>`;
  }
  /* Cable TV */
  if (service.includes('cable') || type.includes('cable') ||
      service.includes('tv') || type.includes('tv')) {
    return `<div class="tx-icon tx-icon-cable">${ICONS.cable}</div>`;
  }
  /* Exam */
  if (service.includes('exam') || type.includes('exam')) {
    return `<div class="tx-icon tx-icon-exam">${ICONS.exam}</div>`;
  }

  /* Deposits / funding */
  if (type.includes('wallet_topup') || type.includes('topup') ||
      type.includes('fund') || type.includes('deposit') || type.includes('bonus')) {
    return `<div class="tx-icon tx-icon-deposit">${ICONS.deposit}</div>`;
  }
  /* Withdrawal */
  if (type.includes('withdraw')) {
    return `<div class="tx-icon tx-icon-withdraw">${ICONS.withdraw}</div>`;
  }
  /* Transfer */
  if (type.includes('transfer') || type.includes('send')) {
    return `<div class="tx-icon tx-icon-transfer">${ICONS.transfer}</div>`;
  }

  return `<div class="tx-icon tx-icon-generic">${ICONS.generic}</div>`;
}

function friendlyTitle(tx) {
  const meta     = tx.metadata || {};
  const net      = meta.network_name || meta.network || '';
  const phone    = meta.phone || '';
  const type     = String(tx.type || '').toLowerCase();
  const service  = String(tx.service || '').toLowerCase();
  const status   = String(tx.status || '').toLowerCase();

  if (status === 'refunded') return 'Refund';
  if (type.includes('wallet_topup') || type.includes('fund') || type.includes('deposit')) {
    return 'Deposit via bank_transfer';
  }
  if (type.includes('withdraw')) return 'Withdrawal request' + (phone ? ' to ' + phone : '');
  if (type.includes('transfer') || type.includes('send')) return 'Transfer' + (phone ? ' to ' + phone : '');

  if (service.includes('airtime') || type.includes('airtime')) return net ? `${net} Airtime` : 'Airtime Purchase';
  if (service.includes('data') || type.includes('data'))       return net ? `${net} Data` : 'Data Purchase';
  if (service.includes('cable') || type.includes('cable') ||
      service.includes('tv') || type.includes('tv'))            return 'Cable Subscription';
  if (service.includes('electric') || type.includes('electric'))return 'Electricity';
  if (service.includes('exam') || type.includes('exam'))        return 'Exam PIN';

  if (tx.description && tx.description.length <= 50) return tx.description;
  return 'Transaction';
}

function statusInfo(tx) {
  const s = String(tx.status || '').toLowerCase();
  if (s === 'success' || s === 'successful' || s === 'completed') return { label: 'SUCCESSFUL', cls: 'success' };
  if (s === 'pending' || s === 'processing' || s === 'in_progress' || s === 'submitted') return { label: 'PENDING', cls: 'pending' };
  if (s === 'failed' || s === 'failure' || s === 'rejected') return { label: 'FAILED', cls: 'failed' };
  if (s === 'refunded') return { label: 'REFUNDED', cls: 'refunded' };
  return { label: 'PENDING', cls: 'pending' };
}

/* FILTER */
function applyFilters() {
  const search = state.search.toLowerCase().trim();

  state.filtered = state.allTransactions.filter((tx) => {
    if (state.filters.category !== 'all') {
      if (classify(tx) !== state.filters.category) return false;
    }
    if (state.filters.status !== 'all') {
      const s = statusInfo(tx).cls;
      if (state.filters.status === 'success'    && s !== 'success')    return false;
      if (state.filters.status === 'processing' && s !== 'pending')    return false;
      if (state.filters.status === 'failed'     && s !== 'failed' && s !== 'refunded') return false;
    }
    if (search) {
      const meta = tx.metadata || {};
      const haystack = [
        tx.reference, tx.description,
        meta.phone, meta.network, meta.network_name,
        String(tx.amount),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  state.currentPage = 1;
  state.totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));

  updateHeaderCount();
  updateFilterBadge();
  renderPage();
}

function updateHeaderCount() {
  if (txCount) txCount.textContent = String(state.filtered.length);
}

function updateFilterBadge() {
  if (!txFilterBadge) return;
  const n = (state.filters.category !== 'all' ? 1 : 0) + (state.filters.status !== 'all' ? 1 : 0);
  if (n > 0) {
    txFilterBadge.textContent = String(n);
    txFilterBadge.classList.remove('hidden');
    txFilterFab?.classList.add('tx-filter-fab-active');
  } else {
    txFilterBadge.classList.add('hidden');
    txFilterFab?.classList.remove('tx-filter-fab-active');
  }
}

/* RENDER */
function renderPage() {
  if (!txReal) return;
  const total = state.filtered.length;

  if (!total) {
    txEmpty.classList.remove('hidden');
    txReal.classList.add('hidden');
    txReal.innerHTML = '';
    txPagination.classList.add('hidden');
    if (txEmptyTitle) txEmptyTitle.textContent = 'No transactions found';
    if (txEmptyText)  txEmptyText.textContent  = state.search ? `No matches for "${state.search}".` : 'Try changing the filters.';
    return;
  }

  txEmpty.classList.add('hidden');

  const from = (state.currentPage - 1) * PAGE_SIZE;
  const to   = Math.min(from + PAGE_SIZE, total);
  const pageItems = state.filtered.slice(from, to);

  txReal.innerHTML = pageItems.map((tx, idx) => {
    const realIdx = from + idx;
    const title   = friendlyTitle(tx);
    const status  = statusInfo(tx);
    const when    = formatRelativeTime(tx.created_at || tx.createdAt);
    const amt     = formatNaira(Math.abs(Number(tx.amount || 0)));

    return `
      <div class="tx-item" data-tx-idx="${realIdx}" role="button" tabindex="0">
        ${txIconMarkup(tx)}
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(title)}</div>
          <div class="tx-meta">
            <span class="tx-when">${escapeHtml(when)}</span>
            <span class="tx-pill tx-pill-${status.cls}">${escapeHtml(status.label)}</span>
          </div>
        </div>
        <div class="tx-amount">${escapeHtml(amt)}</div>
      </div>`;
  }).join('');

  txReal.classList.remove('hidden');

  txReal.querySelectorAll('.tx-item').forEach((row) => {
    const idx = Number(row.dataset.txIdx);
    const tx = state.filtered[idx];
    if (!tx) return;
    row.addEventListener('click', () => openTxModal(tx));
  });

  renderPagination();
}

/* PAGINATION */
function renderPagination() {
  if (!txPagination || !pgNumbers) return;
  if (state.totalPages <= 1) {
    txPagination.classList.add('hidden');
    return;
  }
  txPagination.classList.remove('hidden');

  const total = state.totalPages;
  const cur   = state.currentPage;
  const pages = [];
  const add = (n) => { if (!pages.includes(n)) pages.push(n); };

  add(1);
  for (let i = cur - 1; i <= cur + 1; i++) if (i > 1 && i < total) add(i);
  if (total > 1) add(total);
  pages.sort((a, b) => a - b);

  let html = '';
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += `<span class="pg-ellipsis">…</span>`;
    html += `<button type="button" class="pg-num ${p === cur ? 'active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }
  pgNumbers.innerHTML = html;

  pgNumbers.querySelectorAll('.pg-num').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (page === state.currentPage) return;
      state.currentPage = page;
      renderPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  if (pgPrev) pgPrev.disabled = state.currentPage === 1;
  if (pgNext) pgNext.disabled = state.currentPage === state.totalPages;
}

if (pgPrev) {
  pgPrev.addEventListener('click', () => {
    if (state.currentPage <= 1) return;
    state.currentPage--;
    renderPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
if (pgNext) {
  pgNext.addEventListener('click', () => {
    if (state.currentPage >= state.totalPages) return;
    state.currentPage++;
    renderPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* STATUS CHIPS */
if (txStatusChips) {
  txStatusChips.addEventListener('click', (e) => {
    const btn = e.target.closest('.tx-chip');
    if (!btn) return;
    txStatusChips.querySelectorAll('.tx-chip').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    state.filters.status = btn.dataset.status;
    applyFilters();
  });
}

/* DROPDOWN quick cycle */
if (typeDropdownBtn) {
  typeDropdownBtn.addEventListener('click', () => {
    const order = ['all', 'deposits', 'withdrawals', 'refunded', 'transfers'];
    const labels = { all: 'All Types', deposits: 'Deposits', withdrawals: 'Withdrawals', refunded: 'Refunded', transfers: 'Transfers' };
    const i = order.indexOf(state.filters.category);
    const next = order[(i + 1) % order.length];
    state.filters.category = next;
    if (typeDropdownLabel) typeDropdownLabel.textContent = labels[next];
    applyFilters();
  });
}

/* FILTER SHEET */
function openFilterSheet() {
  draftCategory = state.filters.category;
  syncFilterSheet();
  filterSheet.classList.remove('hidden');
  requestAnimationFrame(() => filterSheet.classList.add('show'));
  document.body.style.overflow = 'hidden';
}
function closeFilterSheet() {
  filterSheet.classList.remove('show');
  document.body.style.overflow = '';
  setTimeout(() => filterSheet.classList.add('hidden'), 260);
}
function syncFilterSheet() {
  if (!filterBody) return;
  filterBody.querySelectorAll('.filter-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.value === draftCategory);
  });
}

if (txFilterFab)   txFilterFab.addEventListener('click', openFilterSheet);
if (filterClose)   filterClose.addEventListener('click', closeFilterSheet);
if (filterSheet) {
  filterSheet.addEventListener('click', (e) => {
    if (e.target === filterSheet) closeFilterSheet();
  });
}
if (filterBody) {
  filterBody.addEventListener('click', (e) => {
    const card = e.target.closest('.filter-card');
    if (!card) return;
    draftCategory = card.dataset.value;
    syncFilterSheet();
  });
}

if (filterReset) {
  filterReset.addEventListener('click', () => {
    draftCategory = 'all';
    state.filters.category = 'all';
    state.filters.status = 'all';
    state.search = '';
    if (txSearchInput) txSearchInput.value = '';
    if (txSearchClear) txSearchClear.classList.add('hidden');
    if (txStatusChips) {
      txStatusChips.querySelectorAll('.tx-chip').forEach((c) => c.classList.toggle('active', c.dataset.status === 'all'));
    }
    if (typeDropdownLabel) typeDropdownLabel.textContent = 'All Types';
    syncFilterSheet();
    closeFilterSheet();
    applyFilters();
  });
}

if (filterApply) {
  filterApply.addEventListener('click', () => {
    state.filters.category = draftCategory;
    const labels = { all: 'All Types', deposits: 'Deposits', withdrawals: 'Withdrawals', refunded: 'Refunded', transfers: 'Transfers' };
    if (typeDropdownLabel) typeDropdownLabel.textContent = labels[draftCategory] || 'All Types';
    closeFilterSheet();
    applyFilters();
  });
}

/* SEARCH */
let searchTimer = null;
if (txSearchInput) {
  txSearchInput.addEventListener('input', (e) => {
    state.search = e.target.value || '';
    if (txSearchClear) txSearchClear.classList.toggle('hidden', !state.search);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 180);
  });
}
if (txSearchClear) {
  txSearchClear.addEventListener('click', () => {
    if (txSearchInput) txSearchInput.value = '';
    state.search = '';
    txSearchClear.classList.add('hidden');
    applyFilters();
  });
}

/* MODAL */
function openTxModal(tx) {
  if (!txModal) return;
  currentTx = tx;

  const status = statusInfo(tx);
  const title  = friendlyTitle(tx);
  const amt    = formatNaira(Math.abs(Number(tx.amount || 0)));
  const meta   = tx.metadata || {};

  const heroClass = status.cls === 'success' ? 'txm-success'
                  : status.cls === 'failed'  ? 'txm-failed'
                  : status.cls === 'refunded'? 'txm-refunded'
                  : 'txm-processing';
  if (txmHero) {
    txmHero.classList.remove('txm-success', 'txm-failed', 'txm-processing', 'txm-refunded');
    txmHero.classList.add(heroClass);
  }

  const iconSvg = status.cls === 'success' ? ICONS.check
                : status.cls === 'failed'  ? ICONS.x
                : status.cls === 'refunded'? ICONS.undo
                : ICONS.clock;
  if (txmHeroIcon) txmHeroIcon.innerHTML = iconSvg;

  if (txmStatus) { txmStatus.textContent = status.label; txmStatus.className = `txm-status ${status.cls}`; }
  if (txmTitle)  txmTitle.textContent = title;
  if (txmAmount) txmAmount.textContent = amt;

  if (txmRecipient) txmRecipient.textContent = meta.phone || '—';
  if (txmReference) txmReference.textContent = tx.reference || '—';
  if (txmDate)      txmDate.textContent      = formatDateTimeFull(tx.created_at || tx.createdAt);
  if (txmType)      txmType.textContent      = title;
  if (txmNetwork)   txmNetwork.textContent   = meta.network_name || meta.network || '—';
  if (txmRemark)    txmRemark.textContent    = tx.description || status.label;

  txModal.classList.remove('hidden');
  requestAnimationFrame(() => txModal.classList.add('show'));
  document.body.style.overflow = 'hidden';
}

function closeTxModal() {
  if (!txModal) return;
  txModal.classList.remove('show');
  document.body.style.overflow = '';
  setTimeout(() => {
    txModal.classList.add('hidden');
    currentTx = null;
  }, 260);
}

if (txmClose) txmClose.addEventListener('click', closeTxModal);
if (txmDone)  txmDone.addEventListener('click', closeTxModal);
if (txModal) {
  txModal.addEventListener('click', (e) => { if (e.target === txModal) closeTxModal(); });
}

if (txmCopy) {
  txmCopy.addEventListener('click', async () => {
    if (!currentTx?.reference) return;
    try {
      await navigator.clipboard.writeText(currentTx.reference);
      txmCopy.style.color = '#0a4534';
      setTimeout(() => { txmCopy.style.color = ''; }, 900);
    } catch {}
  });
}

if (txmShare) {
  txmShare.addEventListener('click', async () => {
    if (!currentTx) return;
    const text =
      `Shatova Receipt\n─────────────\n` +
      `${friendlyTitle(currentTx)}\n` +
      `Amount: ${formatNaira(Math.abs(Number(currentTx.amount || 0)))}\n` +
      `Status: ${statusInfo(currentTx).label}\n` +
      `Reference: ${currentTx.reference || '—'}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Shatova Receipt', text }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(text); } catch {}
    }
  });
}

if (txmPrint) {
  txmPrint.addEventListener('click', () => {
    if (!currentTx) return;
    const meta = currentTx.metadata || {};
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    const statusLabel = statusInfo(currentTx).label;

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
        .remark { margin-top: 16px; padding: 12px; background: #f7f9f8; border-radius: 8px; font-size: 12px; line-height: 1.5; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 2px dashed #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
      </style></head><body>
      <div class="head"><div class="brand">SHATOVA</div><div class="sub">Transaction Receipt</div></div>
      <div class="amount">${formatNaira(Math.abs(Number(currentTx.amount || 0)))}</div>
      <div class="status">${statusLabel}</div>
      <div class="row"><span class="label">Type</span><span class="value">${friendlyTitle(currentTx)}</span></div>
      <div class="row"><span class="label">Recipient</span><span class="value">${meta.phone || '—'}</span></div>
      <div class="row"><span class="label">Reference</span><span class="value">${currentTx.reference || '—'}</span></div>
      <div class="row"><span class="label">Date</span><span class="value">${formatDateTimeFull(currentTx.created_at || currentTx.createdAt)}</span></div>
      <div class="remark">${currentTx.description || ''}</div>
      <div class="footer">Thank you for using Shatova</div>
      <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
      </body></html>
    `);
    w.document.close();
  });
}

/* FETCH */
async function fetchAllTransactions() {
  state.loading = true;
  if (txSkeleton) txSkeleton.classList.remove('hidden');
  if (txReal) txReal.classList.add('hidden');
  if (txEmpty) txEmpty.classList.add('hidden');

  const params = new URLSearchParams();
  params.set('limit', '200');
  params.set('offset', '0');
  params.set('type', 'all');

  try {
    const res = await fetch(`${API_BASE}/wallet/transactions?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (res.status === 401 || res.status === 403) { redirectToLogin(); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      if (txSkeleton) txSkeleton.classList.add('hidden');
      if (txEmpty) {
        txEmpty.classList.remove('hidden');
        if (txEmptyTitle) txEmptyTitle.textContent = 'Could not load transactions';
        if (txEmptyText)  txEmptyText.textContent  = json.message || 'Please try again.';
      }
      return;
    }

    state.allTransactions = json.data?.transactions || [];
    if (txSkeleton) txSkeleton.classList.add('hidden');
    applyFilters();

  } catch (err) {
    console.error('[transactions] fetch:', err);
    if (txSkeleton) txSkeleton.classList.add('hidden');
    if (txEmpty) {
      txEmpty.classList.remove('hidden');
      if (txEmptyTitle) txEmptyTitle.textContent = 'Could not load transactions';
      if (txEmptyText)  txEmptyText.textContent  = 'Please check your connection.';
    }
  } finally {
    state.loading = false;
  }
}

async function init() {
  if (!getToken()) { redirectToLogin(); return; }
  await fetchAllTransactions();
}

init();