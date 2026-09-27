// frontend/js/filter.js
// ============================================================
// Shatova — Reusable Filter Component
//   Usage:
//     import { FilterComponent } from '/js/filter.js';
//
//     const filter = new FilterComponent({
//       mount:   document.getElementById('filterMount'),
//       title:   'Filter products',
//       subtitle:'Select one subcategory to narrow this product list.',
//       options: [
//         { value: 'all',     label: 'All products', count: 8 },
//         { value: 'daily',   label: 'DAILY',        count: 1 },
//         { value: 'weekly',  label: 'WEEKLY',       count: 3 },
//         { value: 'monthly', label: 'MONTHLY',      count: 4 },
//       ],
//       onChange: (value) => { /* filter your list */ },
//     });
// ============================================================

export class FilterComponent {
  constructor({
    mount,
    title = 'Filter products',
    subtitle = 'Select one subcategory to narrow this product list.',
    options = [],
    onChange = () => {},
  } = {}) {
    if (!mount) throw new Error('[FilterComponent] `mount` element is required.');

    this.mount    = mount;
    this.title    = title;
    this.subtitle = subtitle;
    this.options  = Array.isArray(options) ? options : [];
    this.onChange = onChange;

    this.selected = this.options[0]?.value ?? null;
    this.draft    = this.selected;

    this._build();
    this._renderList();
    this._updateButtonState();
  }

  /* ---------------- PUBLIC API ---------------- */

  setOptions(options = []) {
    this.options = Array.isArray(options) ? options : [];
    if (!this.options.some(o => o.value === this.selected)) {
      this.selected = this.options[0]?.value ?? null;
      this.draft = this.selected;
    }
    this._renderList();
    this._updateButtonState();
  }

  getValue() {
    return this.selected;
  }

  reset() {
    this.selected = this.options[0]?.value ?? null;
    this.draft = this.selected;
    this._renderList();
    this._updateButtonState();
    this.onChange(this.selected);
  }

  open()  { this._openModal(); }
  close() { this._closeModal(); }

  destroy() {
    this._closeModal();
    if (this._bar)      this._bar.remove();
    if (this._backdrop) this._backdrop.remove();
  }

  /* ---------------- INTERNALS ---------------- */

  _build() {
    this._bar = document.createElement('div');
    this._bar.className = 'filter-bar';
    this._bar.innerHTML = `
      <button type="button" class="filter-btn" aria-label="Filter">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"
             stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2">
          <path d="M4 6h16M7 12h10M10 18h4"/>
        </svg>
        <span>Filter</span>
        <span class="filter-count hidden"></span>
      </button>`;
    this.mount.innerHTML = '';
    this.mount.appendChild(this._bar);

    this._button  = this._bar.querySelector('.filter-btn');
    this._countEl = this._bar.querySelector('.filter-count');
    this._button.addEventListener('click', () => this._openModal());

    this._backdrop = document.createElement('div');
    this._backdrop.className = 'filter-modal-backdrop hidden';
    this._backdrop.innerHTML = `
      <div class="filter-sheet" role="dialog" aria-modal="true">
        <div class="filter-sheet-grip"></div>

        <div class="filter-sheet-head">
          <div class="filter-sheet-title">${this._esc(this.title)}</div>
          <button type="button" class="filter-sheet-close" aria-label="Close">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"
                 stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
              <path d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="filter-sheet-sub">${this._esc(this.subtitle)}</div>

        <div class="filter-list"></div>

        <div class="filter-sheet-foot">
          <button type="button" class="filter-btn-clear">Clear</button>
          <button type="button" class="filter-btn-apply">Apply filter</button>
        </div>
      </div>`;
    document.body.appendChild(this._backdrop);

    this._listEl  = this._backdrop.querySelector('.filter-list');
    this._applyEl = this._backdrop.querySelector('.filter-btn-apply');
    this._clearEl = this._backdrop.querySelector('.filter-btn-clear');

    this._backdrop.querySelector('.filter-sheet-close')
      .addEventListener('click', () => this._closeModal());

    this._backdrop.addEventListener('click', (e) => {
      if (e.target === this._backdrop) this._closeModal();
    });

    this._onKey = (e) => {
      if (e.key === 'Escape' && !this._backdrop.classList.contains('hidden')) {
        this._closeModal();
      }
    };
    document.addEventListener('keydown', this._onKey);

    this._clearEl.addEventListener('click', () => {
      this.draft = this.options[0]?.value ?? null;
      this._renderList();
    });

    this._applyEl.addEventListener('click', () => {
      this.selected = this.draft;
      this._updateButtonState();
      this._closeModal();
      this.onChange(this.selected);
    });
  }

  _renderList() {
    if (!this._listEl) return;

    if (!this.options.length) {
      this._listEl.innerHTML = `
        <div style="padding:20px;text-align:center;color:#6b7280;font-size:12.5px;">
          No options available
        </div>`;
      return;
    }

    this._listEl.innerHTML = this.options.map((opt) => {
      const isSel = opt.value === this.draft;
      const count = Number(opt.count ?? 0);
      return `
        <button type="button" class="filter-row ${isSel ? 'selected' : ''}"
                data-value="${this._esc(opt.value)}">
          <span class="filter-row-radio"></span>
          <span class="filter-row-label">${this._esc(opt.label)}</span>
          ${!isSel ? `<span class="filter-row-count">${count}</span>` : ''}
          <svg class="filter-row-check" fill="none" stroke="currentColor" viewBox="0 0 24 24"
               stroke-linecap="round" stroke-linejoin="round" stroke-width="2.8">
            <path d="M5 13l4 4L19 7"/>
          </svg>
        </button>`;
    }).join('');

    this._listEl.querySelectorAll('.filter-row').forEach((row) => {
      row.addEventListener('click', () => {
        this.draft = row.dataset.value;
        this._renderList();
      });
    });
  }

  _updateButtonState() {
    if (!this._button) return;
    const isDefault = this.selected === (this.options[0]?.value ?? null);
    this._button.classList.toggle('active', !isDefault);

    if (isDefault) {
      this._countEl.classList.add('hidden');
      this._countEl.textContent = '';
    } else {
      this._countEl.classList.remove('hidden');
      this._countEl.textContent = '1';
    }
  }

  _openModal() {
    this.draft = this.selected;
    this._renderList();
    this._backdrop.classList.remove('hidden');
    requestAnimationFrame(() => this._backdrop.classList.add('show'));
    document.body.style.overflow = 'hidden';
  }

  _closeModal() {
    if (!this._backdrop) return;
    this._backdrop.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(() => this._backdrop.classList.add('hidden'), 240);
  }

  _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}