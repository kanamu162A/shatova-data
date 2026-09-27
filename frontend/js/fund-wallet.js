// frontend/js/fund-wallet.js
// ============================================================
// Shatova — Fund Wallet
//   1. Enter amount
//   2. Pay to Moniepoint account + toggle "I have sent"
//   3. Fast verification → credited
//   Now: FASTER polling + AUTO-REDIRECT to home on completion
// ============================================================

const API_BASE = window.API_BASE;

/* ============================================================
   CONFIG
   ============================================================ */
const PAYMENT_ACCOUNT = {
  bank:   'Moniepoint MFB',
  number: '6034037129',
  name:   'Umar Mannir Abubakar',
};

/* Auto-redirect delay after completion (ms) */
const AUTO_HOME_DELAY_SUCCESS = 1400;
const AUTO_HOME_DELAY_FAILED  = 2600;   // slightly longer so user reads the message

/* Polling speed */
const POLL_INTERVAL_FAST = 350;    // first 20 tries
const POLL_INTERVAL_SLOW = 900;    // after that
const POLL_FAST_LIMIT    = 20;

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
  amount:         0,
  depositId:      null,
  pollTimer:      null,
  sentConfirmed:  false,
  currentStep:    'amount',
  startedAt:      0,
  pollCount:      0,
  progressTimer:  null,
  isVerifying:    false,
  redirectTimer:  null,
};

/* ============================================================
   DOM
   ============================================================ */
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const stepAmount   = $('#stepAmount');
const stepAccount  = $('#stepAccount');
const stepWaiting  = $('#stepWaiting');

const amountInput   = $('#amountInput');
const quickAmounts  = $('#quickAmounts');
const continueBtn   = $('#continueBtn');
const backBtn       = $('#backBtn');
const submitBtn     = $('#submitBtn');
const sentToggle    = $('#sentToggle');
const copyBtn       = $('#copyBtn');
const tryAgainBtn   = $('#tryAgainBtn');
const goHomeBtn     = $('#goHomeBtn');
const pageBackBtn   = $('#pageBackBtn');

const balanceEl     = $('#balanceAmount');
const payAmount     = $('#payAmount');
const receiptAmount = $('#receiptAmount');
const receiptStatus = $('#receiptStatus');
const progressBar   = $('#progressBar');

const waitingIcon   = $('#waitingIcon');
const waitingTitle  = $('#waitingTitle');
const waitingSub    = $('#waitingSub');
const msgSuccess    = $('#msgSuccess');
const msgFailed     = $('#msgFailed');

const psTransfer    = $('#psTransfer');
const psVerify      = $('#psVerify');
const psCredited    = $('#psCredited');

const accountNumberEls = $$('[data-account-number], #accountNumber, .fw-account-number');
const accountNameEls   = $$('[data-account-name],   #accountName,   .fw-account-name');
const bankNameEls      = $$('[data-bank-name],      #bankName,      .fw-bank-name');

/* ============================================================
   HELPERS
   ============================================================ */
function formatNaira(n) {
  return Number(n || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function showStep(step) {
  [stepAmount, stepAccount, stepWaiting].forEach((s) => s && s.classList.add('hidden'));
  if (step) step.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setCurrentStep(name) {
  state.currentStep = name;
}

function paintAccountDetails() {
  accountNumberEls.forEach((el) => { el.textContent = PAYMENT_ACCOUNT.number; });
  accountNameEls.forEach((el)   => { el.textContent = PAYMENT_ACCOUNT.name;   });
  bankNameEls.forEach((el)      => { el.textContent = PAYMENT_ACCOUNT.bank;   });
}

/* ============================================================
   API
   ============================================================ */
async function fetchBalance() {
  const res = await fetch(`${API_BASE}/wallet/balance`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return 0; }
  const json = await res.json().catch(() => ({}));
  return Number(json.data?.balance ?? json.balance ?? 0);
}

async function createDeposit(amount) {
  const res = await fetch(`${API_BASE}/wallet/deposit`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ amount: Number(amount), payment_method: 'bank_transfer' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Failed to create deposit');
  return json.data || json;
}

async function checkDepositStatus(id) {
  const res = await fetch(`${API_BASE}/wallet/deposit/${id}/status`, { headers: authHeaders() });
  const json = await res.json().catch(() => ({}));
  return json.data || json;
}

/* ============================================================
   AMOUNT — step 1
   ============================================================ */
function updateAmountState() {
  const amt = Number(amountInput.value) || 0;
  state.amount = amt;
  continueBtn.disabled = amt < 100;

  quickAmounts?.querySelectorAll('.fw-quick-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.amt) === amt);
  });
}

if (amountInput) {
  amountInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
    updateAmountState();
  });
}

if (quickAmounts) {
  quickAmounts.addEventListener('click', (e) => {
    const btn = e.target.closest('.fw-quick-btn');
    if (!btn) return;
    amountInput.value = btn.dataset.amt;
    updateAmountState();
  });
}

/* ============================================================
   STEP 1 → STEP 2
   ============================================================ */
if (continueBtn) {
  continueBtn.addEventListener('click', () => {
    const amt = Number(amountInput.value);
    if (!amt || amt < 100) return;
    if (amt > 500000) {
      alert('Maximum deposit is ₦500,000');
      return;
    }

    state.amount        = amt;
    state.sentConfirmed = false;

    sentToggle?.classList.remove('active');
    if (submitBtn) submitBtn.disabled = true;

    if (payAmount)     payAmount.textContent     = formatNaira(amt);
    if (receiptAmount) receiptAmount.textContent = formatNaira(amt);

    paintAccountDetails();
    setCurrentStep('account');
    showStep(stepAccount);
  });
}

/* ============================================================
   BACK
   ============================================================ */
function handleBack() {
  if (state.currentStep === 'account') {
    setCurrentStep('amount');
    showStep(stepAmount);
    return;
  }
  if (state.currentStep === 'waiting') return;
  window.location.href = '/home.html';
}

if (backBtn)     backBtn.addEventListener('click', handleBack);
if (pageBackBtn) pageBackBtn.addEventListener('click', handleBack);

/* ============================================================
   COPY ACCOUNT NUMBER
   ============================================================ */
if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(PAYMENT_ACCOUNT.number);
      } else {
        const ta = document.createElement('textarea');
        ta.value = PAYMENT_ACCOUNT.number;
        ta.style.position = 'fixed';
        ta.style.opacity  = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 900);
    } catch {}
  });
}

/* ============================================================
   TOGGLE
   ============================================================ */
if (sentToggle) {
  sentToggle.addEventListener('click', () => {
    state.sentConfirmed = !state.sentConfirmed;
    sentToggle.classList.toggle('active', state.sentConfirmed);
    if (submitBtn) submitBtn.disabled = !state.sentConfirmed;
  });
}

/* ============================================================
   SUBMIT → STEP 3
   ============================================================ */
if (submitBtn) {
  submitBtn.addEventListener('click', async () => {
    if (!state.sentConfirmed) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="fw-spinner"></span> Confirming…';

    try {
      const result = await createDeposit(state.amount);
      state.depositId = result?.id || result?.deposit_id;
      if (!state.depositId) throw new Error('Could not start verification');

      setCurrentStep('waiting');
      showStep(stepWaiting);
      startVerification();
    } catch (err) {
      alert(err.message || 'Something went wrong. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm payment';
    }
  });
}

/* ============================================================
   VERIFICATION
   ============================================================ */

function stopAllTimers() {
  if (state.pollTimer)     { clearTimeout(state.pollTimer);      state.pollTimer     = null; }
  if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  if (state.redirectTimer) { clearTimeout(state.redirectTimer);  state.redirectTimer = null; }
  state.isVerifying = false;
}

function setProgressStep(step) {
  [psTransfer, psVerify, psCredited].forEach((el) => el?.classList.remove('active', 'done'));
  if (step >= 1 && psTransfer) psTransfer.classList.add('done');
  if (step >= 2 && psVerify)   psVerify.classList.add('done');
  if (step >= 3 && psCredited) psCredited.classList.add('done');

  if (step === 1 && psVerify)   psVerify.classList.add('active');
  if (step === 2 && psCredited) psCredited.classList.add('active');
}

/* ------------------------------------------------------------
   Status classifiers
   ------------------------------------------------------------ */
function normalizeStatus(s) {
  return String(s || '').toLowerCase().trim();
}

function isSuccessStatus(s) {
  return ['successful', 'success', 'completed', 'complete', 'credited', 'approved', 'paid']
    .includes(normalizeStatus(s));
}

function isDeclinedStatus(s) {
  return ['declined', 'rejected', 'disapproved', 'denied']
    .includes(normalizeStatus(s));
}

function isFailedStatus(s) {
  return ['failed', 'cancelled', 'canceled', 'expired', 'error']
    .includes(normalizeStatus(s));
}

function pickReasonMessage(result) {
  if (!result || typeof result !== 'object') return '';
  const meta = result.metadata || {};
  const candidates = [
    result.admin_note,
    result.admin_message,
    result.reason,
    result.decline_reason,
    result.failure_reason,
    result.message,
    result.description,
    meta.admin_note,
    meta.reason,
    meta.fail_reason,
    meta.message,
  ];
  for (const c of candidates) {
    if (c && String(c).trim().length > 0) return String(c).trim();
  }
  return '';
}

/* ============================================================
   START VERIFICATION — FASTER polling
   ============================================================ */
function startVerification() {
  if (state.isVerifying) return;
  state.isVerifying = true;

  /* Reset UI */
  waitingIcon?.classList.remove('success', 'failed');
  waitingIcon?.classList.add('pending');
  if (waitingTitle) waitingTitle.textContent = 'Verifying your payment';
  if (waitingSub)   waitingSub.textContent   = 'This usually takes a few seconds.';
  if (receiptStatus) {
    receiptStatus.textContent = 'Processing';
    receiptStatus.className   = 'fw-status-pending';
  }
  msgSuccess?.classList.add('hidden');
  msgFailed?.classList.add('hidden');
  tryAgainBtn?.classList.add('hidden');
  goHomeBtn?.classList.add('hidden');

  /* Progress bar — quick ease toward 70% */
  let progress = 0;
  if (progressBar) progressBar.style.width = '0%';
  stopAllTimers();
  state.isVerifying = true;
  state.progressTimer = setInterval(() => {
    progress += 2.2;
    if (progress >= 70) {
      progress = 70;
      clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
    if (progressBar) progressBar.style.width = progress + '%';
  }, 60);

  setProgressStep(1);
  state.startedAt = Date.now();
  state.pollCount = 0;

  const pollOnce = async () => {
    state.pollCount++;
    try {
      const result = await checkDepositStatus(state.depositId);
      const status = result?.status;

      if (isSuccessStatus(status)) {
        return completeVerification('success', result);
      }
      if (isDeclinedStatus(status)) {
        return completeVerification('declined', result);
      }
      if (isFailedStatus(status)) {
        return completeVerification('failed', result);
      }

      if (state.pollCount >= 2) setProgressStep(2);
      scheduleNext();
    } catch {
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (!state.isVerifying) return;
    const delay = state.pollCount < POLL_FAST_LIMIT
      ? POLL_INTERVAL_FAST
      : POLL_INTERVAL_SLOW;
    state.pollTimer = setTimeout(pollOnce, delay);
  };

  /* Fire first poll immediately */
  state.pollTimer = setTimeout(pollOnce, 200);
}

/* ============================================================
   COMPLETE VERIFICATION — success · declined · failed
   + AUTO-REDIRECT to home
   ============================================================ */
function completeVerification(kind, result) {
  stopAllTimers();
  const elapsed = Date.now() - state.startedAt;

  if (kind === 'success') {
    waitingIcon?.classList.remove('pending', 'failed');
    waitingIcon?.classList.add('success');
    if (waitingTitle) waitingTitle.textContent = 'Payment confirmed';
    if (waitingSub)   waitingSub.textContent   = 'Your wallet has been credited. Returning home…';
    if (receiptStatus) {
      receiptStatus.textContent = 'Successful';
      receiptStatus.className   = 'fw-status-success';
    }
    if (progressBar) progressBar.style.width = '100%';
    setProgressStep(3);

    msgSuccess?.classList.remove('hidden');
    msgFailed?.classList.add('hidden');
    tryAgainBtn?.classList.add('hidden');
    goHomeBtn?.classList.add('hidden');

    /* Update balance in cache immediately */
    fetchBalance().then((bal) => {
      if (balanceEl) balanceEl.textContent = formatNaira(bal);
      localStorage.setItem('walletBalance', String(bal));
    }).catch(() => {});

    /* AUTO-REDIRECT after brief success view */
    state.redirectTimer = setTimeout(() => {
      window.location.replace('/home.html');
    }, AUTO_HOME_DELAY_SUCCESS);
  }

  else if (kind === 'declined') {
    waitingIcon?.classList.remove('pending', 'success');
    waitingIcon?.classList.add('failed');
    if (waitingTitle) waitingTitle.textContent = 'Payment could not be confirmed';
    if (waitingSub) {
      waitingSub.textContent =
        'Your transfer was reviewed but could not be approved. No funds were added. Returning home…';
    }
    if (receiptStatus) {
      receiptStatus.textContent = 'Not approved';
      receiptStatus.className   = 'fw-status-failed';
    }
    if (progressBar) progressBar.style.width = '100%';

    msgSuccess?.classList.add('hidden');
    msgFailed?.classList.remove('hidden');
    tryAgainBtn?.classList.add('hidden');
    goHomeBtn?.classList.add('hidden');

    const reason = pickReasonMessage(result);
    const strongEl = msgFailed?.querySelector('strong');
    const textEl   = msgFailed?.querySelector('small, span, p');
    if (strongEl) strongEl.textContent = 'Payment not approved';
    if (textEl) {
      textEl.textContent = reason
        ? reason
        : 'We reviewed your transfer but could not approve it. No funds were added. Please contact support if you need help.';
    }

    /* AUTO-REDIRECT after slightly longer delay */
    state.redirectTimer = setTimeout(() => {
      window.location.replace('/home.html');
    }, AUTO_HOME_DELAY_FAILED);
  }

  else {
    waitingIcon?.classList.remove('pending', 'success');
    waitingIcon?.classList.add('failed');
    if (waitingTitle) waitingTitle.textContent = 'Payment not received';
    if (waitingSub) {
      waitingSub.textContent =
        "We couldn't find your transfer in the Moniepoint account. Returning home…";
    }
    if (receiptStatus) {
      receiptStatus.textContent = 'Not received';
      receiptStatus.className   = 'fw-status-failed';
    }
    if (progressBar) progressBar.style.width = '100%';

    msgSuccess?.classList.add('hidden');
    msgFailed?.classList.remove('hidden');
    tryAgainBtn?.classList.add('hidden');
    goHomeBtn?.classList.add('hidden');

    const reason = pickReasonMessage(result);
    const strongEl = msgFailed?.querySelector('strong');
    const textEl   = msgFailed?.querySelector('small, span, p');
    if (strongEl) strongEl.textContent = 'We could not verify your transfer';
    if (textEl) {
      textEl.textContent = reason
        ? reason
        : 'If you already sent the money, please wait a moment and try again.';
    }

    /* AUTO-REDIRECT after longer delay so user reads the error */
    state.redirectTimer = setTimeout(() => {
      window.location.replace('/home.html');
    }, AUTO_HOME_DELAY_FAILED);
  }

  try { console.debug(`[fund-wallet] finished in ${elapsed}ms as "${kind}"`); } catch {}
}

/* ============================================================
   RETRY / HOME — kept for backward compat, auto-redirect
   will fire first anyway
   ============================================================ */
if (tryAgainBtn) {
  tryAgainBtn.addEventListener('click', () => {
    stopAllTimers();
    state.sentConfirmed = false;
    sentToggle?.classList.remove('active');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Confirm payment';
    }
    setCurrentStep('account');
    showStep(stepAccount);
  });
}

if (goHomeBtn) {
  goHomeBtn.addEventListener('click', () => {
    stopAllTimers();
    window.location.replace('/home.html');
  });
}

window.addEventListener('beforeunload', stopAllTimers);

/* ============================================================
   BALANCE
   ============================================================ */
async function loadBalance() {
  try {
    const bal = await fetchBalance();
    if (balanceEl) balanceEl.textContent = formatNaira(bal);
    localStorage.setItem('walletBalance', String(bal));
  } catch {}
}

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  if (!getToken()) { redirectToLogin(); return; }
  paintAccountDetails();

  const cached = localStorage.getItem('walletBalance');
  if (cached && balanceEl) balanceEl.textContent = formatNaira(Number(cached));

  loadBalance();
  updateAmountState();
  setCurrentStep('amount');
  showStep(stepAmount);
}

boot();