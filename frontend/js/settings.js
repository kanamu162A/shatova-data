// frontend/js/settings.js
// ============================================================
// Shatova — Settings page
// Logout wipes: storage · cookies · IndexedDB · service workers
//               + forces backend to forget PIN
// ============================================================

const API_BASE = window.API_BASE;

function getToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}
function authHeaders() {
  const t = getToken();
  return t
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
    : { 'Content-Type': 'application/json' };
}
function redirectToLogin() { window.location.href = '/login.html'; }

/* ============================================================
   Load user profile
   ============================================================ */
async function loadUser() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
    if (res.status === 401 || res.status === 403) { redirectToLogin(); return; }
    const json = await res.json().catch(() => ({}));
    const user = json.data?.user || json.user;
    if (!user) return;

    const name = user.name || 'Shatova User';
    const email = user.email || 'user@example.com';
    const initial = (name.split(' ')[0] || 'S').charAt(0).toUpperCase();

    document.getElementById('profileAvatar').textContent = initial;
    document.getElementById('profileName').textContent = name;
    document.getElementById('profileEmail').textContent = email;

    const pinStatus = document.getElementById('pinStatus');
    if (pinStatus) {
      pinStatus.textContent = user.hasPin
        ? 'PIN is set · Tap to change'
        : 'Set a 4-digit PIN';
    }
  } catch (err) {
    console.error('[settings] loadUser:', err);
  }
}

/* ============================================================
   Theme toggle
   ============================================================ */
const themeToggle = document.getElementById('themeToggle');

function refreshThemeToggle() {
  const current = document.documentElement.dataset.theme || 'light';
  if (themeToggle) themeToggle.checked = current === 'dark';
}

refreshThemeToggle();

themeToggle?.addEventListener('change', () => {
  const newTheme = themeToggle.checked ? 'dark' : 'light';
  if (typeof window.__setTheme === 'function') {
    window.__setTheme(newTheme);
  } else {
    document.documentElement.dataset.theme = newTheme;
    try { localStorage.setItem('shatova_theme', newTheme); } catch {}
  }
});

/* ============================================================
   Font size
   ============================================================ */
const fontSizeSegment = document.getElementById('fontSizeSegment');

function refreshFontSizeSegment() {
  const saved = localStorage.getItem('shatova_fontsize') || 'medium';
  if (!fontSizeSegment) return;
  fontSizeSegment.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.size === saved);
  });
}

refreshFontSizeSegment();

fontSizeSegment?.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.size;
    if (typeof window.__setFontSize === 'function') {
      window.__setFontSize(size);
    } else {
      const zoomMap = { small: 0.9, medium: 1, large: 1.1 };
      const zoom = zoomMap[size] || 1;
      document.body.style.zoom = zoom;
      try { localStorage.setItem('shatova_fontsize', size); } catch {}
    }
    refreshFontSizeSegment();
  });
});

/* ============================================================
   Notification toggles
   ============================================================ */
const pushToggle  = document.getElementById('pushToggle');
const emailToggle = document.getElementById('emailToggle');
const bioToggle   = document.getElementById('bioToggle');

try {
  if (pushToggle)  pushToggle.checked  = localStorage.getItem('shatova_push')  !== 'false';
  if (emailToggle) emailToggle.checked = localStorage.getItem('shatova_email') === 'true';
  if (bioToggle)   bioToggle.checked   = localStorage.getItem('shatova_bio')   === 'true';
} catch { /* ignore */ }

pushToggle?.addEventListener('change', () => {
  try { localStorage.setItem('shatova_push', pushToggle.checked); } catch {}
});
emailToggle?.addEventListener('change', () => {
  try { localStorage.setItem('shatova_email', emailToggle.checked); } catch {}
});
bioToggle?.addEventListener('change', () => {
  try { localStorage.setItem('shatova_bio', bioToggle.checked); } catch {}
});

/* ============================================================
   LOGOUT — full wipe + backend forget PIN
   ============================================================ */

/* ---------- 1. Storage / cookie wipe ---------- */
function wipeClientStorage() {
  const knownKeys = [
    'token', 'user',
    'pinVerified', 'pin_verified', 'pinToken', 'pin_token',
    'pin', 'user_pin', 'shatova_pin',
    'shatova_token', 'auth_token', 'access_token', 'refresh_token',
    'lastPath', 'pinAttempts', 'pin_attempts',
  ];

  try {
    knownKeys.forEach(function (k) {
      try { localStorage.removeItem(k);   } catch {}
      try { sessionStorage.removeItem(k); } catch {}
    });
  } catch {}

  try { localStorage.clear(); }   catch {}
  try { sessionStorage.clear(); } catch {}

  /* Cookies */
  try {
    const cookies = document.cookie ? document.cookie.split(';') : [];
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i];
      const eqPos = c.indexOf('=');
      const name = eqPos > -1 ? c.substr(0, eqPos).trim() : c.trim();
      if (!name) continue;
      const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie = name + '=;' + expire + ';path=/';
      document.cookie = name + '=;' + expire + ';path=/;domain=' + location.hostname;
      document.cookie = name + '=;' + expire + ';path=/;domain=.' + location.hostname;
    }
  } catch {}
}

/* ---------- 2. IndexedDB wipe ---------- */
async function wipeIndexedDB() {
  try {
    if (!('indexedDB' in window)) return;
    if (typeof indexedDB.databases !== 'function') return;
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map(function (db) {
      if (!db || !db.name) return Promise.resolve();
      return new Promise(function (resolve) {
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      });
    }));
  } catch {}
}

/* ---------- 3. Service worker + cache wipe ---------- */
async function wipeServiceWorkers() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(function (r) { return r.unregister().catch(function () {}); }));
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k).catch(function () {}); }));
    }
  } catch {}
}

/* ---------- 4. Backend "forget my PIN" call ---------- */
async function tellBackendToForgetPin() {
  const token = getToken();
  const endpoints = [
    '/auth/pin-logout',
    '/auth/logout',
    '/auth/pin/reset',
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(API_BASE + ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',   // send cookies too
      });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

/* ---------- 5. The full logout flow ---------- */
async function doLogout() {
  // a) Backend first — while we still have the token
  await tellBackendToForgetPin();

  // b) Wipe storage, cookies, IndexedDB, SW caches
  wipeClientStorage();
  await wipeIndexedDB();
  await wipeServiceWorkers();

  // c) Redirect with a logout flag + cache-bust (replace → no Back)
  window.location.replace('/login.html?logout=1&t=' + Date.now());
}

document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
  if (!confirm('Sign out of your account?')) return;

  const btn = e.currentTarget;
  const original = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML =
    '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid rgba(10,69,52,0.25);border-top-color:#0a4534;animation:shatovaSpin .65s linear infinite;margin-right:6px;vertical-align:-2px;"></span> Signing out…';

  try {
    await doLogout();
  } catch (err) {
    // Safety net — if anything throws, still clear client-side and go to login
    console.warn('[settings] logout error:', err);
    try { localStorage.clear(); }   catch {}
    try { sessionStorage.clear(); } catch {}
    window.location.replace('/login.html?logout=1&t=' + Date.now());
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

/* ============================================================
   Delete account (placeholder)
   ============================================================ */
document.getElementById('deleteBtn')?.addEventListener('click', () => {
  if (!confirm('This will permanently delete your account. Continue?')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone?')) return;
  alert('Account deletion requires email confirmation. Contact support@shatova.com.');
});

/* ============================================================
   Init
   ============================================================ */
if (!getToken()) {
  redirectToLogin();
} else {
  loadUser();
}