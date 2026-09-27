// frontend/js/pin.js
// ============================================================
// Shatova — PIN gate (setup + verify + fingerprint)
//   • Professional loading states
//   • Green feedback for success, red for errors
//   • Slim, refined typography
// ============================================================

const API_BASE = '/api/v1';

const PIN_LENGTH = 4;
const HOME_URL   = '/home.html';
const LOGIN_URL  = '/login.html';

/* ── AUTH ────────────────────────────────────────────────── */
function getToken() {
  const candidates = [
    localStorage.getItem('token'),
    sessionStorage.getItem('token'),
    localStorage.getItem('shatova_token'),
    sessionStorage.getItem('shatova_token'),
    localStorage.getItem('access_token'),
    sessionStorage.getItem('access_token'),
  ];
  for (const t of candidates) {
    if (t && t !== 'undefined' && t !== 'null' && t.length > 10) return t;
  }
  return null;
}

function clearAuth() {
  ['token', 'shatova_token', 'access_token', 'user'].forEach(k => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
  sessionStorage.removeItem('pinVerified');
}

function markVerified() {
  sessionStorage.setItem('pinVerified', 'true');
}

function authHeaders(extra) {
  const t = getToken();
  return Object.assign({
    'Content-Type': 'application/json',
  }, t ? { Authorization: 'Bearer ' + t } : {}, extra || {});
}

/* ── DOM ─────────────────────────────────────────────────── */
const lockEl     = document.getElementById('pinLock');
const titleEl    = document.getElementById('pinTitle');
const subtitleEl = document.getElementById('pinSubtitle');
const dotsEl     = document.getElementById('pinDots');
const dots       = dotsEl ? Array.from(dotsEl.querySelectorAll('.pin-dot')) : [];
const errorEl    = document.getElementById('pinError');
const padEl      = document.getElementById('pinPad');
const bioBtn     = document.getElementById('pinBio');
const bottomBtn  = document.getElementById('pinBottom');

/* ── STATE ───────────────────────────────────────────────── */
const state = {
  mode: 'setup',
  stage: 'enter',
  pin: '',
  firstPin: '',
  busy: false,
  hasPin: false,
  hasBiometric: false,
  biometricCredentialId: null,
  errorTimer: null,
  originalTitle: '',
  originalSubtitle: '',
  logoutBusy: false,
};

/* ── HELPERS ─────────────────────────────────────────────── */
function paintDots() {
  dots.forEach((d, i) => d.classList.toggle('filled', i < state.pin.length));
}

function clearError() {
  if (state.errorTimer) clearTimeout(state.errorTimer);
  state.errorTimer = null;
  if (dotsEl) dotsEl.classList.remove('error', 'success');
  if (lockEl) lockEl.classList.remove('error', 'success');
  if (errorEl) {
    errorEl.classList.remove('show', 'success');
    errorEl.textContent = '';
  }
}

/* Red, slim error message */
function showError(msg) {
  clearError();
  if (dotsEl) dotsEl.classList.add('error');
  if (lockEl) lockEl.classList.add('error');
  if (errorEl) {
    errorEl.classList.remove('success');
    errorEl.textContent = msg;
    errorEl.classList.add('show');
  }
  state.errorTimer = setTimeout(() => {
    clearError();
    state.pin = '';
    paintDots();
  }, 1400);
}

/* Green, slim success message */
function showSuccess(msg) {
  // Remove any error styling
  if (dotsEl) dotsEl.classList.remove('error');
  if (lockEl) lockEl.classList.remove('error');
  if (dotsEl) dotsEl.classList.add('success');
  if (lockEl) lockEl.classList.add('success');
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.classList.add('show', 'success');
  }
}

function setTitles(t, s) {
  if (titleEl)    titleEl.textContent = t;
  if (subtitleEl) subtitleEl.textContent = s;
}

function rememberTitles() {
  state.originalTitle = titleEl ? titleEl.textContent : '';
  state.originalSubtitle = subtitleEl ? subtitleEl.textContent : '';
}

function showLoadingState(titleText, subtitleText) {
  if (titleEl) titleEl.textContent = titleText;
  if (subtitleEl) subtitleEl.textContent = subtitleText;
  if (lockEl) {
    lockEl.classList.remove('error', 'success');
    lockEl.classList.add('loading');
  }
}

function setPadEnabled(enabled) {
  if (!padEl) return;
  padEl.querySelectorAll('.pin-key').forEach(btn => {
    btn.disabled = !enabled;
    btn.style.pointerEvents = enabled ? '' : 'none';
  });
}

/* ── MODES ───────────────────────────────────────────────── */
function showSetupMode() {
  state.mode = 'setup';
  state.stage = 'enter';
  state.firstPin = '';
  state.pin = '';
  setTitles(
    'Create your PIN',
    'Set a 4-digit PIN to secure your transactions'
  );
  rememberTitles();
  if (lockEl) { lockEl.classList.remove('setup', 'loading'); lockEl.classList.add('setup'); }
  if (dotsEl) dotsEl.classList.add('setup');
  if (bioBtn) bioBtn.hidden = true;
  if (bottomBtn) { bottomBtn.textContent = 'Cancel'; bottomBtn.classList.remove('primary'); }
  paintDots();
  clearError();
  setPadEnabled(true);
}

function showConfirmStage() {
  state.stage = 'confirm';
  state.pin = '';
  setTitles(
    'Confirm your PIN',
    'Please re-enter the same 4 digits'
  );
  rememberTitles();
  if (lockEl) lockEl.classList.remove('loading');
  paintDots();
  clearError();
  setPadEnabled(true);
}

function showVerifyMode() {
  state.mode = 'verify';
  state.stage = 'enter';
  state.pin = '';
  setTitles(
    'Welcome back',
    'Enter your 4-digit PIN to continue'
  );
  rememberTitles();
  if (lockEl) lockEl.classList.remove('setup', 'loading');
  if (dotsEl) dotsEl.classList.remove('setup');
  if (bottomBtn) { bottomBtn.textContent = 'Log Out'; bottomBtn.classList.remove('primary'); }
  if (bioBtn && state.hasBiometric) bioBtn.hidden = false;
  paintDots();
  clearError();
  setPadEnabled(true);
}

/* ── KEY ─────────────────────────────────────────────────── */
function pushDigit(d) {
  if (state.busy) return;
  if (state.pin.length >= PIN_LENGTH) return;
  state.pin += d;
  paintDots();
  if (state.pin.length === PIN_LENGTH) setTimeout(onComplete, 180);
}

function backspace() {
  if (state.busy) return;
  state.pin = state.pin.slice(0, -1);
  paintDots();
  clearError();
}

function clearAll() {
  if (state.busy) return;
  state.pin = '';
  paintDots();
  clearError();
}

/* ── API ─────────────────────────────────────────────────── */
async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success, json, status: res.status };
}

/* ── FLOW ────────────────────────────────────────────────── */
async function onComplete() {
  if (state.mode === 'verify') return verifyPin();
  if (state.stage === 'enter') {
    state.firstPin = state.pin;
    showConfirmStage();
    return;
  }
  if (state.stage === 'confirm') return savePin();
}

/* ── SAVE PIN (setup flow) ───────────────────────────────── */
async function savePin() {
  if (state.pin !== state.firstPin) {
    showError('The PINs you entered do not match. Please try again.');
    state.firstPin = '';
    setTimeout(showSetupMode, 1400);
    return;
  }

  state.busy = true;
  setPadEnabled(false);
  showLoadingState(
    'Securing your account',
    'Your PIN is being encrypted and saved'
  );

  try {
    const r = await api('/auth/set-pin', { pin: state.pin, confirmPin: state.pin });

    if (r.ok) {
      markVerified();
      showSuccess('PIN created successfully');

      if (lockEl) { lockEl.classList.remove('loading'); lockEl.classList.add('success'); }
      setTitles(
        'Setup complete',
        'Redirecting you to your dashboard'
      );

      setTimeout(() => { location.href = HOME_URL; }, 900);
      return;
    }

    if (lockEl) lockEl.classList.remove('loading');
    state.busy = false;
    setPadEnabled(true);
    setTitles(state.originalTitle, state.originalSubtitle);
    showError(r.json.message || 'We could not save your PIN at this time. Please try again.');
  } catch (e) {
    if (lockEl) lockEl.classList.remove('loading');
    state.busy = false;
    setPadEnabled(true);
    setTitles(state.originalTitle, state.originalSubtitle);
    showError('A network error occurred. Please check your connection and try again.');
  }
}

/* ── VERIFY PIN ──────────────────────────────────────────── */
async function verifyPin() {
  state.busy = true;
  setPadEnabled(false);
  showLoadingState(
    'Verifying your identity',
    'Confirming your PIN. This will only take a moment'
  );

  try {
    const r = await api('/auth/verify-pin', { pin: state.pin });

    if (r.ok) {
      markVerified();
      showSuccess('Identity verified');

      if (lockEl) { lockEl.classList.remove('loading'); lockEl.classList.add('success'); }
      setTitles(
        'Access granted',
        'Welcome back. Loading your account'
      );

      setTimeout(() => { location.href = HOME_URL; }, 900);
      return;
    }

    // Wrong PIN
    if (lockEl) lockEl.classList.remove('loading');
    state.busy = false;
    setPadEnabled(true);
    setTitles(state.originalTitle, state.originalSubtitle);
    showError('Incorrect PIN. Please try again.');
  } catch (e) {
    if (lockEl) lockEl.classList.remove('loading');
    state.busy = false;
    setPadEnabled(true);
    setTitles(state.originalTitle, state.originalSubtitle);
    showError('A network error occurred. Please check your connection and try again.');
  }
}

/* ── EVENTS ──────────────────────────────────────────────── */
if (padEl) {
  padEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.key;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 120);
    if (key === 'clear') clearAll();
    else if (key === 'back') backspace();
    else if (/^[0-9]$/.test(key)) pushDigit(key);
  });
}

document.addEventListener('keydown', (e) => {
  if (state.busy) return;
  if (e.key >= '0' && e.key <= '9') pushDigit(e.key);
  else if (e.key === 'Backspace') backspace();
  else if (e.key === 'Escape') clearAll();
  else if (e.key === 'Enter' && state.pin.length === PIN_LENGTH) onComplete();
});

/* ── BOTTOM BUTTON — Log Out / Cancel ────────────────────── */
if (bottomBtn) {
  bottomBtn.addEventListener('click', async () => {
    if (state.logoutBusy) return;
    state.logoutBusy = true;

    bottomBtn.disabled = true;
    bottomBtn.style.pointerEvents = 'none';
    bottomBtn.innerHTML = '<span class="pin-spinner"></span> Signing you out';

    setPadEnabled(false);

    if (titleEl) titleEl.textContent = 'Signing out';
    if (subtitleEl) subtitleEl.textContent = 'Thank you for banking with Shatova';
    if (errorEl) {
      errorEl.classList.remove('show', 'success');
      errorEl.textContent = '';
    }

    try {
      if (state.mode === 'verify') {
        await fetch(API_BASE + '/auth/pin-logout', {
          method: 'POST',
          headers: authHeaders(),
        }).catch(() => {});
      }
    } finally {
      clearAuth();
      setTimeout(() => {
        location.href = LOGIN_URL;
      }, 500);
    }
  });
}

/* ── BOOT ────────────────────────────────────────────────── */
(async function boot() {
  const token = getToken();

  if (!token) {
    location.href = LOGIN_URL;
    return;
  }

  if (sessionStorage.getItem('pinVerified') === 'true') {
    location.replace(HOME_URL);
    return;
  }

  try {
    const res = await fetch(API_BASE + '/auth/pin-status', { headers: authHeaders() });
    const json = await res.json().catch(() => ({}));
    const data = json.data || json;

    state.hasPin = !!data.hasPin;
    state.hasBiometric = !!data.hasBiometric;
    state.biometricCredentialId = data.biometricCredentialId || null;

    if (state.hasPin) showVerifyMode();
    else              showSetupMode();
  } catch (err) {
    showSetupMode();
  }

  paintDots();
  clearError();
})();