// frontend/js/category-header.js
// ============================================================
// Shatova — Sticky Category Header
// Renders a sticky page-head + optional ISP chips row.
// Any page can call `mountCategoryHeader({ ... })` to inject it.
// Includes automatic sticky-failure detection + fixed fallback.
// ============================================================

const ISP_CHIPS = [
  { key: 'all',    label: 'ALL',    cls: 'all'    },
  { key: 'airtel', label: 'AIRTEL', cls: 'airtel' },
  { key: 'glo',    label: 'GLO',    cls: 'glo'    },
  { key: 'mtn',    label: 'MTN',    cls: 'mtn'    },
  { key: 't2',     label: 'T2',     cls: 't2'     },
];

/* ------------------------------------------------------------
   Build one chip
   ------------------------------------------------------------ */
function buildChip(chip, activeKey) {
  const isActive = chip.key === activeKey ? ' active' : '';
  return `
    <button
      type="button"
      class="network-chip${isActive}"
      data-network="${chip.key}"
      aria-label="${chip.label}"
    >
      <span class="network-logo ${chip.cls}">${chip.label}</span>
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

    // If sticky failed, topAfter won't be near headerH
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

  // Chip click handlers
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

  // Auto-fix sticky
  ensureStickyWorks(slotId);

  return slot;
}

export { buildCategoryHeader, mountCategoryHeader, ensureStickyWorks, ISP_CHIPS };