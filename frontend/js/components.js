// frontend/js/components.js
// ============================================================
// Shatova shared shell:
//   • Slim header (menu · brand · WhatsApp support)
//   • Bottom nav
//   • Shared NAV_ITEMS array
//   • Admin section in the menu (only if role === 'admin')
//   • Page transitions — SKIPS service cards & action buttons
// ============================================================

/* ⭐ Single source of truth for all nav items */
export const NAV_ITEMS = [
  {
    key: 'home',
    label: 'Home',
    href: '/home.html',
    icon: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1h3a1 1 0 001-1V10"/></svg>`,
  },
  {
    key: 'activity',
    label: 'Activity',
    href: '/transactions.html',
    icon: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>`,
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings.html',
    icon: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
  },
  {
    key: 'support',
    label: 'Support',
    href: '/support.html',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`,
  },
  {
    key: 'profile',
    label: 'Profile',
    href: '/profile.html',
    icon: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`,
  },
];

/* ⭐ Admin nav item — only shown when role === 'admin' */
const ADMIN_NAV_ITEM = {
  key: 'admin',
  label: 'Admin Panel',
  href: '/admin.html',
  badge: 'STAFF',
  icon: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M12 3l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V7l8-4z"/></svg>`,
};

const ADMIN_ROLES = ['admin', 'super_admin', 'superadmin', 'owner'];

/* ============================================================
   AUTH HELPERS — decode JWT client-side
   ============================================================ */
function getToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch {
    return null;
  }
}

export function isAdminUser() {
  const token = getToken();
  if (!token) return false;
  const payload = decodeJwt(token);
  if (!payload) return false;
  const role = String(payload.role || '').toLowerCase();
  return ADMIN_ROLES.includes(role);
}

/* ============================================================
   HEADER
   ============================================================ */
function buildHeader() {
  return `
    <header class="home-topbar">
      <button class="header-icon slim" data-nav-to="/menu.html" aria-label="Menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="7" x2="21" y2="7"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="17" x2="21" y2="17"/>
        </svg>
      </button>

      <a class="brand-center" href="/home.html" aria-label="Shatova Home">
        <span class="brand-name">Shatova</span>
      </a>

      <a class="header-icon slim header-whatsapp"
         href="https://wa.me/2349025338413?text=Hi%20Shatova%20Support"
         target="_blank"
         rel="noopener noreferrer"
         aria-label="WhatsApp Support">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
        </svg>
      </a>
    </header>
  `;
}

/* ============================================================
   BOTTOM NAV
   ============================================================ */
function buildNav() {
  const items = NAV_ITEMS.map(function (item) {
    return `
      <a class="nav-item" href="${item.href}" data-page="${item.key}">
        ${item.icon}
        <span>${item.label}</span>
      </a>
    `;
  }).join('');

  return `<nav class="bottom-nav">${items}</nav>`;
}

/* ============================================================
   MENU NAV LIST
   ============================================================ */
export function buildMenuNav() {
  const regularItems = NAV_ITEMS.map(function (item) {
    return `
      <a class="menu-nav-item" href="${item.href}" data-page="${item.key}">
        <span class="menu-nav-icon">${item.icon}</span>
        <span class="menu-nav-label">${item.label}</span>
        <svg class="menu-nav-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
        </svg>
      </a>
    `;
  }).join('');

  if (isAdminUser()) {
    return `
      ${regularItems}

      <div class="menu-nav-divider">
        <span>Staff</span>
      </div>

      <a class="menu-nav-item menu-nav-item-admin" href="${ADMIN_NAV_ITEM.href}" data-page="${ADMIN_NAV_ITEM.key}">
        <span class="menu-nav-icon">${ADMIN_NAV_ITEM.icon}</span>
        <span class="menu-nav-label">
          ${ADMIN_NAV_ITEM.label}
          <span class="menu-nav-badge">${ADMIN_NAV_ITEM.badge}</span>
        </span>
        <svg class="menu-nav-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
        </svg>
      </a>
    `;
  }

  return regularItems;
}

function getCurrentPage() {
  const p = window.location.pathname.toLowerCase();
  if (p.includes('home') || p === '/' || p.includes('dashboard')) return 'home';
  if (p.includes('transaction') || p.includes('activity'))       return 'activity';
  if (p.includes('settings'))                                    return 'settings';
  if (p.includes('support'))                                     return 'support';
  if (p.includes('profile'))                                     return 'profile';
  if (p.includes('admin'))                                       return 'admin';
  return '';
}

/* ============================================================
   PAGE TRANSITIONS
   ⚠ SKIPS service cards, action buttons, transaction rows,
     and anything with an inline onclick — those handle their
     own loading state and must NOT trigger the fade overlay.
   ============================================================ */
function attachPageTransitions() {
  if (!document.querySelector('.page-fadeout')) {
    const fade = document.createElement('div');
    fade.className = 'page-fadeout';
    document.body.appendChild(fade);

    const bar = document.createElement('div');
    bar.className = 'top-loader';
    document.body.appendChild(bar);
  }

  const fadeEl = document.querySelector('.page-fadeout');
  const barEl  = document.querySelector('.top-loader');

  let pressedEl   = null;
  let pressedHref = null;
  let cancelled   = false;

  function isNavigable(href) {
    if (!href) return false;
    if (href === '#') return false;
    if (href.startsWith('http')) return false;
    if (href.startsWith('mailto:')) return false;
    if (href.startsWith('tel:')) return false;
    if (href.startsWith('javascript:')) return false;
    return true;
  }

  /**
   * ⭐ Return true if this element should NOT trigger the fade.
   * These elements handle their own loading state via inline onclick.
   */
  function shouldSkipTransition(el) {
    if (!el) return false;

    // Anything with an inline onclick (svcGo, btnGo, etc.)
    if (el.hasAttribute('onclick')) return true;

    // Explicit opt-out
    if (el.hasAttribute('data-no-transition')) return true;

    // Service cards
    if (el.closest('.svc-card')) return true;

    // Balance action buttons
    if (el.closest('.balance-actions')) return true;

    // Transaction rows (open modal, not a page)
    if (el.closest('.tx-item')) return true;

    // Modal buttons
    if (el.closest('.txm-backdrop')) return true;
    if (el.closest('.txm-foot')) return true;

    // Anything already in a loading state
    if (el.classList.contains('btn-loading')) return true;
    if (el.classList.contains('is-loading')) return true;

    return false;
  }

  function showLoading(el) {
    el.classList.add('nav-loading');
    fadeEl?.classList.add('show');
    barEl?.classList.add('show');
  }

  function hideLoading(el) {
    if (el) el.classList.remove('nav-loading');
    fadeEl?.classList.remove('show');
    barEl?.classList.remove('show');
  }

  document.addEventListener('pointerdown', function (e) {
    const el = e.target.closest('a[href], [data-nav-to]');
    if (!el) return;
    if (shouldSkipTransition(el)) return;   // ⭐ Skip service cards

    const href = el.getAttribute('href') || el.getAttribute('data-nav-to');
    if (!isNavigable(href)) return;
    if (el.classList.contains('active')) return;
    if (el.classList.contains('unavailable')) return;
    if (el.hasAttribute('disabled')) return;
    if (el.dataset.navigating === '1') return;

    pressedEl   = el;
    pressedHref = href;
    cancelled   = false;
    showLoading(el);
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    if (!pressedEl) return;
    const el = e.target.closest('a[href], [data-nav-to]');
    if (el !== pressedEl) {
      cancelled = true;
      hideLoading(pressedEl);
      pressedEl   = null;
      pressedHref = null;
    }
  }, { passive: true });

  document.addEventListener('pointerup', function (e) {
    if (!pressedEl || cancelled) {
      pressedEl = null; pressedHref = null;
      return;
    }
    const el = e.target.closest('a[href], [data-nav-to]');
    if (el !== pressedEl) {
      hideLoading(pressedEl);
      pressedEl = null; pressedHref = null;
      return;
    }
    const href = pressedHref;
    const targetEl = pressedEl;
    targetEl.dataset.navigating = '1';
    setTimeout(function () { window.location.href = href; }, 60);
    setTimeout(function () {
      hideLoading(targetEl);
      delete targetEl.dataset.navigating;
    }, 1500);
    pressedEl = null; pressedHref = null;
  }, { passive: true });

  document.addEventListener('click', function (e) {
    const el = e.target.closest('a[href], [data-nav-to]');
    if (!el) return;
    if (shouldSkipTransition(el)) return;   // ⭐ Skip service cards

    const href = el.getAttribute('href') || el.getAttribute('data-nav-to');
    if (!isNavigable(href)) return;
    if (el.classList.contains('active')) { e.preventDefault(); return; }
    if (el.dataset.navigating === '1') { e.preventDefault(); return; }
    e.preventDefault();
    showLoading(el);
    el.dataset.navigating = '1';
    setTimeout(function () { window.location.href = href; }, 60);
  });
}

function mount() {
  const headerSlot = document.getElementById('app-header');
  const navSlot    = document.getElementById('app-nav');

  if (headerSlot) headerSlot.innerHTML = buildHeader();
  if (navSlot)    navSlot.innerHTML    = buildNav();

  const current = getCurrentPage();
  document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === current);
  });

  attachPageTransitions();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

export { buildHeader, buildNav, mount, attachPageTransitions };