// frontend/js/auth-guard.js
// ============================================================
// Shatova — Auth + PIN gate
//
//   • Public pages (login, register, pin, terms, debug)
//     → always allowed
//
//   • Protected pages (home, wallet, data, etc.)
//     → require token AND PIN verified this session
// ============================================================

(function () {
  'use strict';

  const PUBLIC_PATHS = [
    '/', '/index.html', '/index',
    '/login.html', '/login',
    '/register.html', '/register',
    '/forgot-password.html', '/forgot-password',
    '/reset-password.html', '/reset-password',
    '/pin.html', '/pin',
    '/terms.html',
    '/debug.html', '/debug',
  ];

  const path = location.pathname;
  if (PUBLIC_PATHS.includes(path)) return;

  const token =
    localStorage.getItem('token') ||
    sessionStorage.getItem('token') ||
    localStorage.getItem('shatova_token') ||
    sessionStorage.getItem('shatova_token');

  // No token → user logged out or never logged in
  if (!token) {
    window.location.replace('/login.html');
    return;
  }

  // Token OK but user hasn't entered PIN this session → PIN page
  if (sessionStorage.getItem('pinVerified') !== 'true') {
    window.location.replace('/pin.html');
    return;
  }
})();