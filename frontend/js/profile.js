// frontend/js/profile.js
// ============================================================
// Profile Page — clean, professional
// Logout wipes: storage · cookies · IndexedDB · service workers
//               + forces backend to forget PIN
// ============================================================

const API_BASE = window.API_BASE;

/* AUTH */
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

/* DOM */
const elAvatar      = document.getElementById('prAvatar');
const elInitials    = document.getElementById('prInitials');
const elName        = document.getElementById('prName');
const elEmail       = document.getElementById('prEmail');
const elFullName    = document.getElementById('prFullName');
const elRowEmail    = document.getElementById('prRowEmail');
const elPhone       = document.getElementById('prPhone');
const elJoined      = document.getElementById('prJoined');
const elUserId      = document.getElementById('prUserId');
const elBalance     = document.getElementById('prBalance');
const elAccStatus   = document.getElementById('prAccountStatus');
const elStatusDot   = document.getElementById('prStatusDot');
const elCopyId      = document.getElementById('prCopyId');

const elAvatarEdit  = document.getElementById('prAvatarEdit');
const elEditBtn     = document.getElementById('prEditBtn');
const elPasswordBtn = document.getElementById('prPasswordBtn');
const elSupportBtn  = document.getElementById('prSupportBtn');
const elLogoutBtn   = document.getElementById('prLogoutBtn');

const logoutModal   = document.getElementById('prLogoutModal');
const logoutCancel  = document.getElementById('prLogoutCancel');
const logoutConfirm = document.getElementById('prLogoutConfirm');

/* HELPERS */
function formatNaira(n) {
  const num = Number(n || 0);
  return '₦ ' + num.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatJoined(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function initials(name) {
  if (!name) return 'S';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function resolveDisplayName(user) {
  if (!user) return '';
  const candidates = [
    user.name, user.fullName, user.full_name,
    user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null,
    user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : null,
    user.firstName, user.first_name, user.username,
  ];
  for (const c of candidates) {
    if (c && String(c).trim().length > 0) return String(c).trim();
  }
  return '';
}

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

/* ============================================================
   POPULATE UI
   ============================================================ */
function applyUser(user) {
  if (!user) return;

  const fullName = resolveDisplayName(user) || 'Shatova User';
  const email    = user.email || '—';
  const phone    = user.phone || user.phone_number || user.phoneNumber || '—';
  const joined   = user.created_at || user.createdAt || user.dateJoined || user.joined_at;
  const userId   = user.id || user.userId || user.user_id || user._id || '—';

  const balance = Number(
    user.balance ?? user.wallet?.balance ?? user.wallet_balance ?? user.walletBalance ?? 0
  );

  /* Avatar */
  if (elInitials) elInitials.textContent = initials(fullName);
  if (elAvatar && user.avatar) {
    elAvatar.style.backgroundImage = `url(${user.avatar})`;
    elAvatar.style.backgroundSize = 'cover';
    elAvatar.style.backgroundPosition = 'center';
    if (elInitials) elInitials.style.display = 'none';
  }

  /* Hero */
  if (elName)  elName.textContent  = fullName;
  if (elEmail) elEmail.textContent = email;

  /* Personal info */
  if (elFullName) elFullName.textContent = fullName;
  if (elRowEmail) elRowEmail.textContent = email;
  if (elPhone)    elPhone.textContent    = phone;
  if (elJoined)   elJoined.textContent   = formatJoined(joined);
  if (elUserId)   elUserId.textContent   = userId;

  /* Account */
  if (elBalance) elBalance.textContent = formatNaira(balance);

  const accStatus = (user.status || user.account_status || (user.is_active === false ? 'inactive' : 'active')).toLowerCase();
  const statusLabel =
    accStatus === 'active'    ? 'Active' :
    accStatus === 'inactive'  ? 'Inactive' :
    accStatus === 'suspended' ? 'Suspended' :
    accStatus.charAt(0).toUpperCase() + accStatus.slice(1);

  if (elAccStatus) elAccStatus.textContent = statusLabel;

  if (elStatusDot) {
    elStatusDot.classList.remove('inactive', 'suspended');
    if (accStatus === 'inactive')  elStatusDot.classList.add('inactive');
    if (accStatus === 'suspended') elStatusDot.classList.add('suspended');
  }

  /* Cache for instant next load */
  try {
    const store = getStore();
    store.setItem('user', JSON.stringify(user));
  } catch {}
}

/* CACHE-FIRST RENDER */
function renderFromCache() {
  try {
    const store = getStore();
    const cached = JSON.parse(store.getItem('user') || 'null');
    if (cached) {
      applyUser(cached);
      return true;
    }
  } catch {}
  return false;
}

/* API */
async function loadMe() {
  const res = await fetch(`${API_BASE}/auth/me`, { method: 'GET', headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { redirectToLogin(); return null; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || 'Could not load profile');
  return extractUser(json);
}

/* COPY USER ID */
if (elCopyId) {
  elCopyId.addEventListener('click', async () => {
    const id = elUserId?.textContent;
    if (!id || id === '—') return;
    try {
      await navigator.clipboard.writeText(id);
      elCopyId.classList.add('copied');
      setTimeout(() => elCopyId.classList.remove('copied'), 900);
    } catch {}
  });
}

/* ACTIONS */
if (elAvatarEdit) elAvatarEdit.addEventListener('click', () => { window.location.href = '/edit-profile.html#avatar'; });
if (elEditBtn)    elEditBtn.addEventListener('click', () => { window.location.href = '/edit-profile.html'; });
if (elPasswordBtn)elPasswordBtn.addEventListener('click', () => { window.location.href = '/change-password.html'; });
if (elSupportBtn) elSupportBtn.addEventListener('click', () => { window.location.href = '/support.html'; });

/* ============================================================
   LOGOUT — wipes EVERYTHING + tells the backend to forget PIN
   ============================================================ */
function openLogoutModal() {
  if (!logoutModal) return;
  logoutModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLogoutModal() {
  if (!logoutModal) return;
  logoutModal.classList.add('hidden');
  document.body.style.overflow = '';
}

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

/* ---------- 3. Service worker wipe ---------- */
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
      // Stop at the first endpoint that returns OK (2xx)
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

/* ---------- 5. The full logout flow ---------- */
async function doLogout() {
  if (logoutConfirm) {
    logoutConfirm.disabled = true;
    logoutConfirm.textContent = 'Logging out…';
  }

  // a) Call backend FIRST while we still have the token
  await tellBackendToForgetPin();

  // b) Wipe storage, cookies, IndexedDB, SW caches
  wipeClientStorage();
  await wipeIndexedDB();
  await wipeServiceWorkers();

  // c) Redirect with a flag so auth-guard knows this is a fresh logout
  //    (replace() so Back can't re-enter)
  window.location.replace('/login.html?logout=1&t=' + Date.now());
}

if (elLogoutBtn)   elLogoutBtn.addEventListener('click', openLogoutModal);
if (logoutCancel)  logoutCancel.addEventListener('click', closeLogoutModal);
if (logoutConfirm) logoutConfirm.addEventListener('click', doLogout);
if (logoutModal) {
  logoutModal.addEventListener('click', (e) => {
    if (e.target === logoutModal) closeLogoutModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && logoutModal && !logoutModal.classList.contains('hidden')) {
    closeLogoutModal();
  }
});

/* BOOT */
async function init() {
  if (!getToken()) { redirectToLogin(); return; }
  renderFromCache();
  try {
    const user = await loadMe();
    if (user) applyUser(user);
  } catch (err) {
    console.warn('[profile] loadMe failed:', err?.message);
  }
}

init();