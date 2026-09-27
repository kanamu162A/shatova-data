// frontend/js/api.js
// ============================================================
// Shatova — API base config + theme + font size
//   Loaded FIRST on every page.
// ============================================================

/* ============================================================
   1. API BASE — resolves to same origin in every environment
   ------------------------------------------------------------
     local:      http://localhost:3000/api/v1
     tunnel:     https://xyz.devtunnels.ms/api/v1
     production: https://shatova.com/api/v1
   ============================================================ */
(function () {
  'use strict';

  if (window.__API_BASE__) {
    window.API_BASE = String(window.__API_BASE__).replace(/\/+$/, '');
    return;
  }

  const meta = document.querySelector('meta[name="api-base"]');
  if (meta && meta.content) {
    window.API_BASE = meta.content.trim().replace(/\/+$/, '');
    return;
  }

  const { protocol, host, hostname } = window.location;

  if (protocol === 'file:') {
    window.API_BASE = 'http://localhost:3000/api/v1';
    return;
  }

  const isProd =
    hostname === 'shatova-data.onrender.com' ||
    hostname === 'shatova.com' ||
    hostname.endsWith('.shatova.com');

  window.API_BASE = isProd
    ? `https://${host}/api/v1`
    : `${protocol}//${host}/api/v1`;

  if (window.console && window.console.debug) {
    console.debug('[api.js] API_BASE =', window.API_BASE);
  }
})();

/* ============================================================
   2. THEME — apply saved theme immediately on every page
   ============================================================ */
(function applySavedTheme() {
  try {
    const saved = localStorage.getItem('shatova_theme') || 'light';
    document.documentElement.dataset.theme = saved;
  } catch (e) { /* ignore */ }
})();

/* ============================================================
   3. FONT SIZE — apply saved font size immediately
   ============================================================ */
(function applySavedFontSize() {
  try {
    const saved = localStorage.getItem('shatova_fontsize') || 'medium';
    const zoomMap = { small: 0.9, medium: 1, large: 1.1 };
    const zoom = zoomMap[saved] || 1;
    document.body.style.zoom = zoom;
  } catch (e) { /* ignore */ }
})();