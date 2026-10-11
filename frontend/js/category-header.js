// frontend/js/category-header.js
// ============================================================
// Shatova — Sticky Category Header
// Real ISP brand logos (static-first + inline SVG fallback)
// Same logo system as airtime / data sections.
// ============================================================

/* Static logo base — change if your assets live elsewhere */
const LOGO_STATIC_BASE = '/static/logos';

/* Inline SVG data-URIs (zero network, instant) — matches data.js / airtime */
const BRAND_LOGOS = (() => {
  const mtn = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="100" fill="#ffcb05"/><ellipse cx="100" cy="100" rx="68" ry="42" fill="none" stroke="#000" stroke-width="8"/><text x="100" y="116" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="48" font-weight="900" fill="#000" letter-spacing="-1.5">MTN</text></svg>`;
  const airtel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="100" fill="#ED1C24"/><text x="100" y="118" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="800" fill="#fff" letter-spacing="-1.2">airtel</text></svg>`;
  const glo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="100" fill="#00A651"/><text x="100" y="122" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="72" font-weight="900" fill="#fff" letter-spacing="-3">glo</text></svg>`;
  const t2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="100" fill="#F26522"/><text x="100" y="122" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="72" font-weight="900" fill="#fff" letter-spacing="-2">T2</text></svg>`;
  const all = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="100" fill="#0a0a0a"/><text x="100" y="118" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="42" font-weight="900" fill="#fff" letter-spacing="1">ALL</text></svg>`;
  const toData = (s) => {
    try {
      return 'data:image/svg+xml;base64,' + btoa(s);
    } catch (_) {
      return 'data:image/svg+xml,' + encodeURIComponent(s);
    }
  };
  return {
    mtn: toData(mtn),
    airtel: toData(airtel),
    glo: toData(glo),
    t2: toData(t2),
    all: toData(all),
  };
})();

/**
 * Resolve logo URL:
 * 1) static file under /static/logos/{key}.svg (or .png)
 * 2) inline SVG data-URI fallback (always works)
 */
function brandLogoSrc(key) {
  const k = String(key || 'all').toLowerCase();
  const map = {
    all: 'all',
    mtn: 'mtn',
    airtel: 'airtel',
    glo: 'glo',
    t2: 't2',
    '9mobile': 't2',
    etisalat: 't2',
  };
  const id = map[k] || 'all';
  // Prefer static path; onerror will swap to data-URI
  return {
    staticUrl: `${LOGO_STATIC_BASE}/${id}.svg`,
    fallback: BRAND_LOGOS[id] || BRAND_LOGOS.all,
    id,
  };
}

const ISP_CHIPS = [
  { key: 'all',    label: 'ALL',    cls: 'all'    },
  { key: 'airtel', label: 'AIRTEL', cls: 'airtel' },
  { key: 'glo',    label: 'GLO',    cls: 'glo'    },
  { key: 'mtn',    label: 'MTN',    cls: 'mtn'    },
  { key: 't2',     label: 'T2',     cls: 't2'     },
];

/* ------------------------------------------------------------
   Build one chip with real brand logo
   ------------------------------------------------------------ */
function buildChip(chip, activeKey) {
  const isActive = chip.key === activeKey ? ' active' : '';
  const { staticUrl, fallback, id } = brandLogoSrc(chip.key);

  // img tries static first; onerror → inline SVG (no extra request after fail)
  const logoInner = `
    <img
      class="isp-logo"
      src="${staticUrl}"
      data-fallback="${fallback}"
      alt="${chip.label}"
      width="32"
      height="32"
      decoding="async"
      loading="eager"
      onerror="this.onerror=null;this.src=this.dataset.fallback"
    />
  `;

  return `
    <button
      type="button"
      class="network-chip${isActive}"
      data-network="${chip.key}"
      aria-label="${chip.label}"
    >
      <span class="network-logo ${chip.cls}" data-provider="${id}">
        ${logoInner}
      </span>
    </button>
  `;
}

/* ------------------------------------------------------------
   Build the full sticky unit HTML
   ------------------------------------------------------------ */
function buildCategoryHeader(cfg = {}) {
  const {
    eyebrow = '',
    title = '',
    showBack = true,
    backHref = '/home.html',
    showChips = true,
    activeNetwork = 'all',
    chipsId = 'networksRow',
  } = cfg;

  const backBtn = showBack
    ? `<button class="back-btn" onclick="location.href='${backHref}'" aria-label="Back">
         <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
         </svg>
       </button>`
    : '';

  const eyebrowEl = eyebrow ? `<div class="page-eyebrow">${eyebrow}</div>` : '';
  const chipsRow = ISP_CHIPS.map(c => buildChip(c, activeNetwork)).join('');
  const chipsBlock = showChips
    ? `<div class="networks-sticky">
         <div class="networks-scroll">
           <div class="networks-row" id="${chipsId}">
             ${chipsRow}
           </div>
         </div>
       </div>`
    : '';

  return `
    <div class="sticky-top-unit">
      <div class="page-head">
        ${backBtn}
        <div class="page-head-titles">
          ${eyebrowEl}
          <h1 class="page-title">${title}</h1>
        </div>
      </div>
      ${chipsBlock}
    </div>
  `;
}

/* ------------------------------------------------------------
   Verify sticky is working. If not, switch to position:fixed.
   ------------------------------------------------------------ */
function ensureStickyWorks(slotId = 'pageHeadSlot') {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  requestAnimationFrame(() => {
    const originalScroll = window.scrollY;
    window.scrollTo(0, 120);
    const topAfter = slot.getBoundingClientRect().top;
    window.scrollTo(0, originalScroll);
    const headerH = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--header-h')
    ) || 46;
    if (Math.abs(topAfter - headerH) > 10) {
      console.warn('[category-header] sticky failed — applying fixed fallback');
      const h = slot.offsetHeight;
      const spacer = document.createElement('div');
      spacer.style.height = h + 'px';
      spacer.style.width = '100%';
      spacer.setAttribute('data-sticky-spacer', '1');
      slot.parentNode.insertBefore(spacer, slot);
      slot.style.position = 'fixed';
      slot.style.top = headerH + 'px';
      slot.style.left = '0';
      slot.style.right = '0';
      slot.style.margin = '0';
      slot.style.zIndex = '30';
    }
  });
}

/* ------------------------------------------------------------
   Mount the category header into a slot element
   ------------------------------------------------------------ */
function mountCategoryHeader(cfg = {}, slotId = 'pageHeadSlot') {
  const slot = document.getElementById(slotId);
  if (!slot) {
    console.warn(`[category-header] #${slotId} not found — skipping mount`);
    return null;
  }
  slot.innerHTML = buildCategoryHeader(cfg);

  const row = slot.querySelector('.networks-row');
  if (row) {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.network-chip');
      if (!chip) return;
      row.querySelectorAll('.network-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const network = chip.dataset.network;
      slot.dispatchEvent(new CustomEvent('network:change', {
        detail: { network },
        bubbles: true,
      }));
    });
  }

  ensureStickyWorks(slotId);
  return slot;
}

export {
  buildCategoryHeader,
  mountCategoryHeader,
  ensureStickyWorks,
  ISP_CHIPS,
  BRAND_LOGOS,
  brandLogoSrc,
  LOGO_STATIC_BASE,
};
