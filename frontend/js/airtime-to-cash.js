// frontend/js/airtime-to-cash.js
// ============================================================
// Shatova — Airtime to Cash
//   User chats admin → admin gives the number to send airtime
//   → user sends → admin pays to user's bank
// ============================================================

const ADMIN_PHONE_INTL = '2349025338413';

/* Per-network payout rates (null = ask admin) */
const RATES = {
  MTN:       0.90,
  AIRTEL:    0.75,
  GLO:       null,
  '9MOBILE': null,
};

const $  = (s) => document.querySelector(s);

/* ============================================================
   STATE
   ============================================================ */
const state = {
  network: '',
  senderPhone: '',
  amount: 0,
  bankName: '',
  accountNumber: '',
  accountName: '',
};

/* ============================================================
   HELPERS
   ============================================================ */
function formatNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('234') && p.length > 10) p = '0' + p.slice(3);
  if (p.length > 0 && /^[789]/.test(p))     p = '0' + p;
  return p.slice(0, 11);
}

function getRate(net) {
  return RATES[net] ?? null;
}

/* ============================================================
   NETWORK PICKER
   ============================================================ */
const networkRow = $('#networkRow');
if (networkRow) {
  networkRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.atc-net');
    if (!btn) return;
    networkRow.querySelectorAll('.atc-net').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.network = btn.dataset.net;
    updatePayout();
  });
}

/* ============================================================
   INPUTS
   ============================================================ */
const senderPhoneEl = $('#senderPhone');
if (senderPhoneEl) {
  senderPhoneEl.addEventListener('input', (e) => {
    e.target.value = normalizePhone(e.target.value);
    state.senderPhone = e.target.value;
  });
}

const amountEl = $('#airtimeAmount');
if (amountEl) {
  amountEl.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
    state.amount = Number(e.target.value) || 0;
    updatePayout();
  });
}

const bankNameEl = $('#bankName');
if (bankNameEl) bankNameEl.addEventListener('input', e => { state.bankName = e.target.value.trim(); });

const accountNumberEl = $('#accountNumber');
if (accountNumberEl) {
  accountNumberEl.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
    state.accountNumber = e.target.value;
  });
}

const accountNameEl = $('#accountName');
if (accountNameEl) accountNameEl.addEventListener('input', e => { state.accountName = e.target.value.trim(); });

/* ============================================================
   PAYOUT PREVIEW
   ============================================================ */
const payoutPreview = $('#payoutPreview');

function updatePayout() {
  if (!payoutPreview) return;

  if (!state.network) {
    payoutPreview.innerHTML = `<span class="atc-payout-empty">Pick a network and enter amount to see what you'll get</span>`;
    return;
  }

  const rate = getRate(state.network);

  if (rate == null) {
    payoutPreview.innerHTML = `<span class="atc-payout-ask">Ask the admin for the ${state.network} rate</span>`;
    return;
  }

  if (!state.amount) {
    payoutPreview.innerHTML = `<span class="atc-payout-rate">${state.network} pays <b>${Math.round(rate * 100)}%</b></span>`;
    return;
  }

  const payout = state.amount * rate;

  payoutPreview.innerHTML = `
    <span class="atc-payout-line">Airtime <b>${formatNaira(state.amount)}</b></span>
    <span class="atc-payout-line">Rate <b>${Math.round(rate * 100)}%</b></span>
    <span class="atc-payout-line total">You get <b>${formatNaira(payout)}</b></span>
  `;
}

/* ============================================================
   VALIDATION
   ============================================================ */
function validate() {
  const errs = [];
  if (!state.network) errs.push('Please pick your network.');
  if (!/^0\d{10}$/.test(state.senderPhone)) errs.push('Enter a valid 11-digit phone number.');
  if (!state.amount || state.amount < 500) errs.push('Minimum airtime is ₦500.');
  if (!state.bankName) errs.push('Enter your bank name.');
  if (!/^\d{10}$/.test(state.accountNumber)) errs.push('Enter a valid 10-digit account number.');
  if (!state.accountName) errs.push('Enter your account name.');
  return errs;
}

/* ============================================================
   BUILD WHATSAPP MESSAGE
   ============================================================ */
function buildMessage() {
  const rate = getRate(state.network);
  const payout = rate != null ? state.amount * rate : null;

  const lines = [
    '*AIRTIME TO CASH REQUEST*',
    '',
    `Network: ${state.network}`,
    `My airtime number: ${state.senderPhone}`,
    `Airtime amount: ${formatNaira(state.amount)}`,
  ];

  if (rate != null) {
    lines.push(`Rate: ${Math.round(rate * 100)}%`);
    lines.push(`Expected payout: ${formatNaira(payout)}`);
  } else {
    lines.push(`Rate: please confirm`);
  }

  lines.push('');
  lines.push('*My bank details*');
  lines.push(`Bank: ${state.bankName}`);
  lines.push(`Account number: ${state.accountNumber}`);
  lines.push(`Account name: ${state.accountName}`);
  lines.push('');
  lines.push('Please send me the number to transfer my airtime to.');

  return lines.join('\n').replace(/\n/g, '%0A');
}

/* ============================================================
   SUBMIT
   ============================================================ */
const sendWaBtn = $('#sendWaBtn');
if (sendWaBtn) {
  sendWaBtn.addEventListener('click', () => {
    const errs = validate();
    if (errs.length) {
      alert(errs.join('\n'));
      return;
    }
    const url = `https://wa.me/${ADMIN_PHONE_INTL}?text=${buildMessage()}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}

/* Top WhatsApp button — only sends form if filled, else generic */
const waBtn = $('#waBtn');
if (waBtn) {
  waBtn.addEventListener('click', (e) => {
    if (!state.network || !state.amount || !state.senderPhone) return;
    e.preventDefault();
    const url = `https://wa.me/${ADMIN_PHONE_INTL}?text=${buildMessage()}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}

updatePayout();