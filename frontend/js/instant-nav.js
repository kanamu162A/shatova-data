// frontend/js/instant-nav.js
// v5 — professional prefetch, safe for inline-onclick elements
// ============================================================
//   • Prefetch ONLY when the user truly intends to navigate
//   • Skips service cards, balance buttons, transaction rows,
//     and anything with an inline onclick (they self-navigate)
//   • Hover-intent 120ms — casual mouse-passes ignored
//   • Never blocks clicks, never races other handlers
//   • Safety net ONLY fires for plain <a> links that got stuck
// ============================================================
(function () {
  'use strict';

  const PREFETCH_ON_IDLE = [
    '/home.html',
    '/fund-wallet.html',
    '/transactions.html',
    '/profile.html',
  ];

  const API_WARMUP = {
    '/home.html':         ['/wallet/transactions?limit=5', '/auth/me'],
    '/transactions.html': ['/wallet/transactions?limit=30'],
    '/fund-wallet.html':  ['/wallet/balance'],
  };

  const API_BASE = (window.API_BASE || '').replace(/\/$/, '');
  const prefetched = new Set();

  const HOVER_INTENT_MS = 120;

  /* ============================================================
     ⭐ Elements that handle their OWN navigation / loading.
     These must be completely ignored by instant-nav — otherwise
     the 250ms safety net races the inline handler and kills
     the smooth loading state.
     ============================================================ */
  function isSelfNavigating(el) {
    if (!el) return false;

    // Inline onclick → svcGo / btnGo / custom handlers
    if (el.hasAttribute('onclick')) return true;

    // Service cards
    if (el.closest('.svc-card')) return true;

    // Balance action buttons (Fund Wallet / Transfer)
    if (el.closest('.balance-actions')) return true;

    // Transaction rows (open modal, not a page)
    if (el.closest('.tx-item')) return true;

    // Modal buttons
    if (el.closest('.txm-backdrop')) return true;
    if (el.closest('.txm-foot')) return true;

    // Already loading — do not race
    if (el.classList.contains('btn-loading')) return true;
    if (el.classList.contains('is-loading')) return true;
    if (el.dataset.loading === '1') return true;
    if (el.dataset.navigating === '1') return true;

    // Explicit opt-out
    if (el.hasAttribute('data-no-transition')) return true;
    if (el.hasAttribute('data-no-prefetch')) return true;

    return false;
  }

  /* ---------------------------------------------------------
     Prefetch HTML + warm API
     --------------------------------------------------------- */
  function prefetch(url) {
    if (!url) return;

    let cleanUrl = url;
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return;
      if (u.pathname === location.pathname && u.search === location.search) return;
      cleanUrl = u.pathname + u.search;
    } catch { return; }

    if (prefetched.has(cleanUrl)) return;
    prefetched.add(cleanUrl);

    /* Prefetch HTML */
    try {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = cleanUrl;
      link.as = 'document';
      document.head.appendChild(link);
    } catch {}

    /* Warm API endpoints */
    const apis = API_WARMUP[cleanUrl] || [];
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');

    apis.forEach((path) => {
      try {
        fetch(API_BASE + path, {
          credentials: 'same-origin',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'force-cache',
        }).catch(() => {});
      } catch {}
    });
  }

  /* ---------------------------------------------------------
     Wire a single <a>
     --------------------------------------------------------- */
  function wire(a) {
    if (!a || a.dataset.pfWired === '1') return;

    const href = a.getAttribute('href');
    if (!href) return;
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (isSelfNavigating(a)) return;   // ⭐ skip service cards, etc.

    a.dataset.pfWired = '1';

    let hoverTimer = null;

    const onEnter = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        try { prefetch(a.href); } catch {}
      }, HOVER_INTENT_MS);
    };

    const onLeave = () => {
      clearTimeout(hoverTimer);
    };

    a.addEventListener('mouseenter', onEnter, { passive: true });
    a.addEventListener('mouseleave', onLeave, { passive: true });

    a.addEventListener('focus', () => {
      try { prefetch(a.href); } catch {}
    }, { passive: true });
  }

  function wireAll() {
    document.querySelectorAll('a[href]').forEach(wire);
  }

  /* ---------------------------------------------------------
     Idle warmup — top destinations only, once page is quiet
     --------------------------------------------------------- */
  function idleWarm() {
    const run = () => {
      PREFETCH_ON_IDLE.forEach((p) => {
        if (location.pathname === p) return;
        try { prefetch(p); } catch {}
      });
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 800);
    }
  }

  /* ---------------------------------------------------------
     SAFETY NET — only for plain <a> links (no inline onclick)
     Skips anything that handles its own loading so it can never
     race svcGo / btnGo / modal buttons.
     --------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (isSelfNavigating(a)) return;   // ⭐ never touch service cards

    const rawHref = a.getAttribute('href');
    if (!rawHref) return;
    if (/^(#|mailto:|tel:|javascript:)/i.test(rawHref)) return;

    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;

    const startHref = location.href;
    const target = a.href;

    setTimeout(() => {
      if (location.href === startHref) {
        window.location.href = target;
      }
    }, 250);
  }, false);

  /* ---------------------------------------------------------
     Watch for late-injected links
     --------------------------------------------------------- */
  function observe() {
    const mo = new MutationObserver(() => wireAll());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  function boot() {
    wireAll();
    observe();
    idleWarm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();