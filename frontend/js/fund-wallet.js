// frontend/js/fund-wallet.js
// Shatova — automatic Paystack wallet funding.
// The browser never credits a wallet. Only the authenticated backend,
// after provider verification, can settle the payment intent.

const API_BASE = String(window.API_BASE || '/api/v1').replace(/\/+$/, '');
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 500000;
const VERIFY_ATTEMPTS = 12;
const VERIFY_DELAY_MS = 1800;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const state = { amount: 0, reference: null, busy: false, verifyTimer: null };

const stepAmount = $('#stepAmount');
const stepAccount = $('#stepAccount');
const stepWaiting = $('#stepWaiting');
const amountInput = $('#amountInput');
const quickAmounts = $('#quickAmounts');
const continueBtn = $('#continueBtn');
const paystackPayBtn = $('#paystackPayBtn');
const backBtn = $('#backBtn');
const pageBackBtn = $('#pageBackBtn');
const balanceEl = $('#balanceAmount');
const payAmount = $('#payAmount');
const receiptAmount = $('#receiptAmount');
const receiptReference = $('#receiptReference');
const receiptStatus = $('#receiptStatus');
const progressBar = $('#progressBar');
const waitingIcon = $('#waitingIcon');
const waitingTitle = $('#waitingTitle');
const waitingSub = $('#waitingSub');
const msgSuccess = $('#msgSuccess');
const msgFailed = $('#msgFailed');
const tryAgainBtn = $('#tryAgainBtn');
const goHomeBtn = $('#goHomeBtn');
const psTransfer = $('#psTransfer');
const psVerify = $('#psVerify');
const psCredited = $('#psCredited');
const paymentError = $('#paymentError');

function token() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}
function authHeaders() {
  const value = token();
  return { 'Content-Type': 'application/json', ...(value ? { Authorization: 'Bearer ' + value } : {}) };
}
function money(value) {
  return Number(value || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function showStep(step) {
  [stepAmount, stepAccount, stepWaiting].forEach((node) => node?.classList.add('hidden'));
  step?.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function showError(message) {
  if (!paymentError) { alert(message); return; }
  paymentError.textContent = message;
  paymentError.classList.remove('hidden');
}
function clearError() {
  paymentError?.classList.add('hidden');
  if (paymentError) paymentError.textContent = '';
}
function goLogin() { window.location.replace('/login.html'); }

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    goLogin();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.message || 'Request failed. Please try again.');
  }
  return body;
}

async function loadBalance() {
  try {
    const body = await requestJson(`${API_BASE}/wallet/balance`);
    const balance = Number(body.data?.balance ?? body.balance ?? 0);
    if (balanceEl) balanceEl.textContent = money(balance);
    localStorage.setItem('walletBalance', String(balance));
  } catch (error) {
    if (error.message && !/session has expired/i.test(error.message)) console.warn('[fund-wallet] balance unavailable:', error.message);
  }
}

function updateAmount() {
  const amount = Number(String(amountInput?.value || '').replace(/\D/g, '')) || 0;
  state.amount = amount;
  if (continueBtn) continueBtn.disabled = !Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT;
  quickAmounts?.querySelectorAll('.fw-quick-btn').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.amt) === amount);
  });
}
amountInput?.addEventListener('input', () => {
  amountInput.value = amountInput.value.replace(/\D/g, '').slice(0, 7);
  updateAmount();
});
quickAmounts?.addEventListener('click', (event) => {
  const button = event.target.closest('.fw-quick-btn');
  if (!button || !amountInput) return;
  amountInput.value = button.dataset.amt;
  updateAmount();
});

continueBtn?.addEventListener('click', () => {
  const amount = Number(amountInput?.value);
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    showError(`Enter an amount from ₦${MIN_AMOUNT} to ₦${MAX_AMOUNT.toLocaleString()}.`);
    return;
  }
  state.amount = amount;
  clearError();
  if (payAmount) payAmount.textContent = money(amount);
  if (receiptAmount) receiptAmount.textContent = money(amount);
  showStep(stepAccount);
});

function goBack() {
  if (!stepAccount?.classList.contains('hidden')) {
    showStep(stepAmount);
    return;
  }
  if (!stepWaiting?.classList.contains('hidden')) return;
  window.location.href = '/home.html';
}
backBtn?.addEventListener('click', goBack);
pageBackBtn?.addEventListener('click', goBack);

paystackPayBtn?.addEventListener('click', async () => {
  if (state.busy) return;
  if (!token()) { goLogin(); return; }
  if (!Number.isInteger(state.amount) || state.amount < MIN_AMOUNT || state.amount > MAX_AMOUNT) {
    showError('Please choose a valid funding amount first.');
    return;
  }

  state.busy = true;
  clearError();
  paystackPayBtn.disabled = true;
  paystackPayBtn.innerHTML = '<span class="fw-spinner"></span> Preparing secure checkout…';

  try {
    const body = await requestJson(`${API_BASE}/paystack/initialize`, {
      method: 'POST',
      body: JSON.stringify({ amount: state.amount }),
    });
    const checkoutUrl = body.data?.authorization_url;
    if (!checkoutUrl || !/^https:\/\/checkout\.paystack\.com\//i.test(checkoutUrl)) {
      throw new Error('The secure checkout link was not returned. Please try again.');
    }
    state.reference = body.data.reference;
    // Hosted checkout is on Paystack; this page resumes from the callback URL.
    window.location.assign(checkoutUrl);
  } catch (error) {
    showError(error.message || 'Unable to start payment. Please try again.');
    state.busy = false;
    paystackPayBtn.disabled = false;
    paystackPayBtn.textContent = 'Continue to secure payment';
  }
});

function setProgress(step) {
  [psTransfer, psVerify, psCredited].forEach((el) => el?.classList.remove('active', 'done'));
  if (step >= 1) psTransfer?.classList.add('done');
  if (step >= 2) psVerify?.classList.add('done');
  if (step >= 3) psCredited?.classList.add('done');
  if (step === 2) psVerify?.classList.add('active');
  if (step === 3) psCredited?.classList.add('active');
}
function setWaiting() {
  showStep(stepWaiting);
  waitingIcon?.classList.remove('success', 'failed');
  waitingIcon?.classList.add('pending');
  if (waitingTitle) waitingTitle.textContent = 'Verifying your payment';
  if (waitingSub) waitingSub.textContent = 'Please keep this page open while Shatova confirms the payment with Paystack.';
  if (receiptStatus) {
    receiptStatus.textContent = 'Verifying';
    receiptStatus.className = 'fw-status-pending';
  }
  msgSuccess?.classList.add('hidden');
  msgFailed?.classList.add('hidden');
  tryAgainBtn?.classList.add('hidden');
  goHomeBtn?.classList.add('hidden');
  if (progressBar) progressBar.style.width = '25%';
  setProgress(1);
}

function finishSuccess(data) {
  if (state.verifyTimer) clearTimeout(state.verifyTimer);
  state.verifyTimer = null;
  waitingIcon?.classList.remove('pending', 'failed');
  waitingIcon?.classList.add('success');
  if (waitingTitle) waitingTitle.textContent = 'Payment confirmed';
  if (waitingSub) waitingSub.textContent = 'Your wallet funding was verified successfully.';
  if (receiptStatus) {
    receiptStatus.textContent = 'Successful';
    receiptStatus.className = 'fw-status-success';
  }
  if (progressBar) progressBar.style.width = '100%';
  setProgress(3);
  msgSuccess?.classList.remove('hidden');
  msgFailed?.classList.add('hidden');
  tryAgainBtn?.classList.add('hidden');
  goHomeBtn?.classList.remove('hidden');
  if (receiptAmount && data?.amount != null) receiptAmount.textContent = money(data.amount);
  loadBalance();
}
function finishPending(message) {
  if (state.verifyTimer) clearTimeout(state.verifyTimer);
  state.verifyTimer = null;
  waitingIcon?.classList.remove('pending', 'success');
  waitingIcon?.classList.add('failed');
  if (waitingTitle) waitingTitle.textContent = 'Payment not confirmed yet';
  if (waitingSub) waitingSub.textContent = message || 'We could not confirm the payment yet. If you completed checkout, check again shortly or contact support.';
  if (receiptStatus) {
    receiptStatus.textContent = 'Pending';
    receiptStatus.className = 'fw-status-pending';
  }
  msgFailed?.classList.remove('hidden');
  tryAgainBtn?.classList.remove('hidden');
  goHomeBtn?.classList.remove('hidden');
}
async function verifyReturnedPayment(reference, attempt = 1) {
  try {
    const body = await requestJson(`${API_BASE}/paystack/verify/${encodeURIComponent(reference)}`);
    const result = body.data || {};
    if (result.status === 'success') {
      finishSuccess(result);
      return;
    }
    if (attempt < VERIFY_ATTEMPTS) {
      if (waitingSub) waitingSub.textContent = `Waiting for provider confirmation… Check ${attempt} of ${VERIFY_ATTEMPTS}.`;
      state.verifyTimer = setTimeout(() => verifyReturnedPayment(reference, attempt + 1), VERIFY_DELAY_MS);
      return;
    }
    finishPending('Paystack has not confirmed this payment yet. Your wallet has not been credited by this page. You can check again or contact support.');
  } catch (error) {
    if (attempt < VERIFY_ATTEMPTS && !/session has expired/i.test(error.message || '')) {
      state.verifyTimer = setTimeout(() => verifyReturnedPayment(reference, attempt + 1), VERIFY_DELAY_MS);
      return;
    }
    finishPending(error.message || 'Unable to verify this payment right now. Please try again.');
  }
}

tryAgainBtn?.addEventListener('click', () => {
  const reference = state.reference;
  if (reference) {
    setWaiting();
    verifyReturnedPayment(reference, 1);
  } else {
    showStep(stepAmount);
  }
});
goHomeBtn?.addEventListener('click', () => window.location.replace('/home.html'));

async function boot() {
  if (!token()) { goLogin(); return; }
  const cached = localStorage.getItem('walletBalance');
  if (cached && balanceEl) balanceEl.textContent = money(Number(cached));
  loadBalance();
  updateAmount();

  const params = new URLSearchParams(window.location.search);
  const reference = params.get('reference') || params.get('trxref');
  if (reference) {
    state.reference = reference;
    if (receiptReference) receiptReference.textContent = reference;
    setWaiting();
    if (continueBtn) continueBtn.disabled = true;
    await verifyReturnedPayment(reference);
    // Remove sensitive/payment query parameters after capturing the reference.
    history.replaceState({}, document.title, window.location.pathname);
    return;
  }
  showStep(stepAmount);
}
window.addEventListener('beforeunload', () => {
  if (state.verifyTimer) clearTimeout(state.verifyTimer);
});
boot();
