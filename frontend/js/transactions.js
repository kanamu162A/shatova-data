```javascript
// frontend/js/transactions.js
// ============================================================
// SHATOVA — COMPLETE TRANSACTION HISTORY & RECEIPTS
// Search • Filters • Pagination • Details • Copy • Share • Print
// Electricity meter • Customer • Address • Disco • Token • kWh
// ============================================================

"use strict";

const API_BASE = String(window.API_BASE || "").replace(/\/+$/, "");
const PAGE_SIZE = 20;

const $ = selector => document.querySelector(selector);
const byId = id => document.getElementById(id);

const state = {
  allTransactions: [],
  filtered: [],
  search: "",
  currentPage: 1,
  totalPages: 1,
  filters: { category: "all", status: "all" }
};

let currentTx = null;
let searchTimer = null;
let modalTimer = null;
let filterTimer = null;
let draftCategory = "all";

function getToken() {
  return localStorage.getItem("token") ||
         sessionStorage.getItem("token") || "";
}

function authHeaders() {
  const token = getToken();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function redirectToLogin() {
  window.location.href = "/login.html";
}

function formatNaira(value) {
  const amount = Number(value);
  return "₦" + (Number.isFinite(amount) ? Math.abs(amount) : 0)
    .toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
}

function formatDateTimeFull(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("en-NG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function formatRelativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;

  const days = Math.floor(minutes / 1440);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  return date.toLocaleDateString("en-NG", {
    day: "2-digit", month: "short", year: "numeric"
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeText(value, fallback = "—") {
  return value == null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function getMetadata(tx) {
  return tx?.metadata && typeof tx.metadata === "object"
    ? tx.metadata : {};
}

function getCreatedAt(tx) {
  return tx?.created_at || tx?.createdAt ||
         tx?.completed_at || tx?.completedAt || tx?.date || null;
}

// ============================================================
// ICONS
// ============================================================

const ICONS = {
  airtime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4l2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5a11 11 0 0 1 14 0M1.5 9a16 16 0 0 1 21 0M8.5 16a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>',
  electricity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 4 14h7l-1 8 10-13h-7z"/></svg>',
  cable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="m8 3 4 4 4-4"/></svg>',
  deposit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16M5 13l7 7 7-7"/></svg>',
  withdraw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V4M5 11l7-7 7 7"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h15l-4-4M20 16H5l4 4"/></svg>',
  refund: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a8 8 0 0 1 8 8v2M3 10l6 6m-6-6 6-6"/></svg>',
  generic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 12 4 4L19 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>'
};

function classify(tx) {
  const type = String(tx?.type || "").toLowerCase();
  const status = String(tx?.status || "").toLowerCase();
  const direction = String(tx?.direction || "").toLowerCase();

  if (status === "refunded" || type.includes("refund")) return "refunded";
  if (/withdraw|cash_out/.test(type)) return "withdrawals";
  if (/transfer|send/.test(type)) return "transfers";

  if (
    /deposit|topup|top_up|fund|credit|bonus/.test(type) ||
    direction === "credit"
  ) return "deposits";

  return "orders";
}

function statusInfo(tx) {
  const status = String(tx?.status || "").toLowerCase();

  if (/^(success|successful|completed|complete|paid)$/.test(status))
    return { label: "SUCCESSFUL", cls: "success" };

  if (/^(failed|failure|rejected|cancelled|canceled)$/.test(status))
    return { label: "FAILED", cls: "failed" };

  if (status === "refunded")
    return { label: "REFUNDED", cls: "refunded" };

  return { label: "PENDING", cls: "pending" };
}

function friendlyTitle(tx) {
  const meta = getMetadata(tx);
  const type = String(tx?.type || "").toLowerCase();
  const service = String(tx?.service || "").toLowerCase();
  const description = String(tx?.description || "");
  const network = meta.network_name || meta.network || tx?.network || "";

  if (classify(tx) === "refunded") return "Refund";
  if (/withdraw|cash_out/.test(type)) return "Withdrawal";
  if (/transfer|send/.test(type)) return "Wallet Transfer";
  if (/deposit|topup|top_up|fund/.test(type)) return "Wallet Funding";
  if (/electric|prepaid meter|postpaid meter/.test(
    `${type} ${service} ${description}`.toLowerCase()
  )) return "Electricity Payment";
  if (/airtime/.test(`${type} ${service}`))
    return network ? `${network} Airtime` : "Airtime Purchase";
  if (/data/.test(`${type} ${service}`))
    return network ? `${network} Data` : "Data Purchase";
  if (/cable|tv/.test(`${type} ${service}`)) return "Cable Subscription";
  if (/exam|waec|jamb/.test(`${type} ${service}`)) return "Exam PIN";

  return description.length <= 60 && description
    ? description : "Transaction";
}

function iconMarkup(tx) {
  const type = String(tx?.type || "").toLowerCase();
  const service = String(tx?.service || "").toLowerCase();
  const group = classify(tx);

  let key = "generic";
  if (group === "refunded") key = "refund";
  else if (group === "deposits") key = "deposit";
  else if (group === "withdrawals") key = "withdraw";
  else if (group === "transfers") key = "transfer";
  else if (/electric|meter/.test(`${type} ${service}`)) key = "electricity";
  else if (/airtime/.test(`${type} ${service}`)) key = "airtime";
  else if (/data/.test(`${type} ${service}`)) key = "data";
  else if (/cable|tv/.test(`${type} ${service}`)) key = "cable";

  return `<div class="tx-icon tx-icon-${key}">${ICONS[key]}</div>`;
}

// ============================================================
// ROBUST RECEIPT DATA EXTRACTION
// ============================================================

function receiptObjects(tx) {
  const objects = [];
  const seen = new Set();

  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }

    objects.push(value);

    [
      "metadata", "meta", "details", "data", "response",
      "provider_response", "providerResponse", "provider_data",
      "providerData", "result", "customer", "electricity",
      "electricity_details", "electricityDetails", "bill",
      "receipt", "transaction", "transaction_details",
      "transactionDetails"
    ].forEach(key => visit(value[key], depth + 1));
  }

  visit(tx);
  return objects;
}

function receiptValue(tx, aliases) {
  const objects = receiptObjects(tx);

  for (const obj of objects) {
    for (const alias of aliases) {
      const value = obj[alias];

      if (value !== undefined && value !== null &&
          String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }

  const normalize = value =>
    String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

  const wanted = new Set(aliases.map(normalize));

  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (wanted.has(normalize(key)) &&
          value !== undefined && value !== null &&
          String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }

  return "";
}

function isElectricityTx(tx) {
  if (!tx) return false;

  const objects = receiptObjects(tx);

  const description = objects.flatMap(obj => [
    obj.type, obj.service, obj.category, obj.description,
    obj.product_name, obj.productName, obj.bill_type, obj.billType
  ]).filter(Boolean).join(" ").toLowerCase();

  if (/\belectricity\b|\belectric\b|\bprepaid meter\b|\bpostpaid meter\b/.test(description))
    return true;

  return Boolean(receiptValue(tx, [
    "meter_number", "meterNumber", "meter_no",
    "electricity_token", "electricityToken",
    "ds_customer_name", "ds_disco"
  ]));
}

function getElectricityReceipt(tx) {
  return {
    meter: receiptValue(tx, [
      "meter_number", "meterNumber", "meter_no", "meterNo",
      "meter", "customer_meter_number", "customerMeterNumber",
      "customer_id", "customerId"
    ]),
    customer: receiptValue(tx, [
      "ds_customer_name", "customer_name", "customerName",
      "customer", "account_name", "accountName",
      "customer_full_name", "customerFullName"
    ]),
    address: receiptValue(tx, [
      "ds_customer_address", "customer_address", "customerAddress",
      "meter_address", "meterAddress", "service_address",
      "serviceAddress", "address"
    ]),
    disco: receiptValue(tx, [
      "ds_disco", "disco", "disco_name", "discoName",
      "electricity_provider", "electricityProvider",
      "provider_name", "providerName", "provider"
    ]),
    token: receiptValue(tx, [
      "ds_token", "electricity_token", "electricityToken",
      "token", "token_code", "tokenCode", "standard_token",
      "standardToken", "vend_token", "vendToken"
    ]),
    units: receiptValue(tx, [
      "ds_units", "units", "kwh", "units_purchased",
      "unitsPurchased", "energy_units", "energyUnits"
    ])
  };
}

function fillElectricityFields(tx) {
  const fields = getElectricityReceipt(tx);
  const electricity = isElectricityTx(tx);

  const rows = [
    ["txmMeterRow", "txmMeter", fields.meter],
    ["txmCustomerRow", "txmCustomer", fields.customer],
    ["txmAddressRow", "txmAddress", fields.address],
    ["txmDiscoRow", "txmDisco", fields.disco]
  ];

  rows.forEach(([rowId, valueId]) => {
    const row = byId(rowId);
    const element = byId(valueId);
    if (row) row.style.display = "none";
    if (element) element.textContent = "";
  });

  const tokenBox = byId("txmTokenBox");
  const tokenEl = byId("txmToken");
  const unitsEl = byId("txmUnits");

  if (tokenBox) tokenBox.style.display = "none";
  if (tokenEl) tokenEl.textContent = "";
  if (unitsEl) unitsEl.textContent = "";

  if (!electricity) return;

  rows.forEach(([rowId, valueId, value]) => {
    const row = byId(rowId);
    const element = byId(valueId);

    if (row && element && value) {
      element.textContent = value;
      row.style.display = "";
    }
  });

  const meta = getMetadata(tx);

  const recipient = fields.meter ||
    receiptValue(tx, ["recipient", "phone", "phone_number", "phoneNumber"]);

  if (byId("txmRecipient"))
    byId("txmRecipient").textContent = recipient || "—";

  if (byId("txmNetwork"))
    byId("txmNetwork").textContent = fields.disco ||
      meta.network_name || meta.network || "—";

  if (tokenBox && (fields.token || fields.units)) {
    tokenBox.style.display = "";

    if (tokenEl)
      tokenEl.textContent = fields.token || "Token not available";

    if (unitsEl) {
      unitsEl.textContent = fields.units ? `${fields.units} kWh` : "";
      unitsEl.style.display = fields.units ? "" : "none";
    }

    const button = byId("txmCopyToken");

    if (button) {
      const fresh = button.cloneNode(true);
      button.replaceWith(fresh);
      fresh.disabled = !fields.token;

      fresh.addEventListener("click", async () => {
        if (!fields.token) {
          alert("No electricity token was returned for this transaction.");
          return;
        }

        try {
          await copyText(fields.token);
          fresh.textContent = "Copied ✓";
          setTimeout(() => {
            fresh.textContent = button.textContent || "Copy token";
          }, 1500);
        } catch {
          window.prompt("Copy your electricity token:", fields.token);
        }
      });
    }
  }
}

// ============================================================
// CLIPBOARD
// ============================================================

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(String(value));
  }

  const textarea = document.createElement("textarea");
  textarea.value = String(value);
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const ok = document.execCommand("copy");
  textarea.remove();

  if (!ok) throw new Error("Copy failed");
}

// ============================================================
// FILTERS AND SEARCH
// ============================================================

function applyFilters() {
  const search = state.search.trim().toLowerCase();

  state.filtered = state.allTransactions.filter(tx => {
    if (state.filters.category !== "all" &&
        classify(tx) !== state.filters.category) return false;

    const status = statusInfo(tx).cls;

    if (state.filters.status === "success" && status !== "success")
      return false;
    if (state.filters.status === "processing" && status !== "pending")
      return false;
    if (state.filters.status === "failed" &&
        status !== "failed" && status !== "refunded") return false;

    if (search) {
      const values = receiptObjects(tx).flatMap(obj => [
        obj.reference, obj.transaction_reference, obj.transactionReference,
        obj.description, obj.phone, obj.meter_number, obj.customer_name,
        obj.network, obj.network_name, obj.token, obj.amount
      ]).filter(value => value != null);

      if (!values.join(" ").toLowerCase().includes(search)) return false;
    }

    return true;
  });

  state.currentPage = 1;
  state.totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));

  const count = byId("txCount");
  if (count) count.textContent = String(state.filtered.length);

  updateFilterBadge();
  renderPage();
}

function updateFilterBadge() {
  const badge = byId("txFilterBadge");
  const fab = byId("txFilterFab");
  if (!badge) return;

  const count =
    (state.filters.category !== "all" ? 1 : 0) +
    (state.filters.status !== "all" ? 1 : 0);

  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  if (fab) fab.classList.toggle("tx-filter-fab-active", count > 0);
}

// ============================================================
// TRANSACTION LIST
// ============================================================

function renderPage() {
  const container = byId("txReal");
  const empty = byId("txEmpty");
  const pagination = byId("txPagination");

  if (!container) return;

  const total = state.filtered.length;

  if (!total) {
    container.innerHTML = "";
    container.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
    if (pagination) pagination.classList.add("hidden");

    if (byId("txEmptyTitle"))
      byId("txEmptyTitle").textContent = "No transactions found";

    if (byId("txEmptyText"))
      byId("txEmptyText").textContent = state.search
        ? `No matches for "${state.search}".`
        : "Your transactions will appear here.";

    return;
  }

  if (empty) empty.classList.add("hidden");

  const start = (state.currentPage - 1) * PAGE_SIZE;
  const items = state.filtered.slice(start, start + PAGE_SIZE);

  container.innerHTML = items.map((tx, index) => {
    const title = friendlyTitle(tx);
    const status = statusInfo(tx);
    const date = formatRelativeTime(getCreatedAt(tx));
    const amount = formatNaira(tx.amount);

    return `
      <div class="tx-item" data-tx-idx="${start + index}"
           role="button" tabindex="0" aria-label="View ${escapeHtml(title)} receipt">
        ${iconMarkup(tx)}
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(title)}</div>
          <div class="tx-meta">
            <span class="tx-when">${escapeHtml(date)}</span>
            <span class="tx-pill tx-pill-${status.cls}">${status.label}</span>
          </div>
        </div>
        <div class="tx-amount">${escapeHtml(amount)}</div>
      </div>`;
  }).join("");

  container.classList.remove("hidden");

  container.querySelectorAll(".tx-item").forEach(row => {
    const open = () => {
      const tx = state.filtered[Number(row.dataset.txIdx)];
      if (tx) openTxModal(tx);
    };

    row.addEventListener("click", open);
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });

  renderPagination();
}

function renderPagination() {
  const pagination = byId("txPagination");
  const numbers = byId("pgNumbers");

  if (!pagination || !numbers) return;

  if (state.totalPages <= 1) {
    pagination.classList.add("hidden");
    return;
  }

  pagination.classList.remove("hidden");

  const current = state.currentPage;
  const total = state.totalPages;
  const pages = new Set([1, total]);

  for (let page = current - 1; page <= current + 1; page++) {
    if (page > 1 && page < total) pages.add(page);
  }

  let previous = 0;
  let html = "";

  [...pages].sort((a, b) => a - b).forEach(page => {
    if (page - previous > 1) html += '<span class="pg-ellipsis">…</span>';

    html += `<button type="button" class="pg-num ${page === current ? "active" : ""}"
             data-page="${page}">${page}</button>`;

    previous = page;
  });

  numbers.innerHTML = html;

  numbers.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      state.currentPage = Number(button.dataset.page);
      renderPage();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  if (byId("pgPrev")) byId("pgPrev").disabled = current === 1;
  if (byId("pgNext")) byId("pgNext").disabled = current === total;
}

function changePage(delta) {
  const next = state.currentPage + delta;

  if (next < 1 || next > state.totalPages) return;

  state.currentPage = next;
  renderPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ============================================================
// RECEIPT MODAL
// ============================================================

function openTxModal(tx) {
  const modal = byId("txModal");
  if (!modal) return;

  currentTx = tx;

  const status = statusInfo(tx);
  const title = friendlyTitle(tx);
  const meta = getMetadata(tx);

  const hero = byId("txmHero");
  if (hero) {
    hero.classList.remove(
      "txm-success", "txm-failed", "txm-processing", "txm-refunded"
    );

    hero.classList.add(
      status.cls === "success" ? "txm-success" :
      status.cls === "failed" ? "txm-failed" :
      status.cls === "refunded" ? "txm-refunded" :
      "txm-processing"
    );
  }

  if (byId("txmHeroIcon")) {
    byId("txmHeroIcon").innerHTML =
      status.cls === "success" ? ICONS.check :
      status.cls === "failed" ? ICONS.x :
      status.cls === "refunded" ? ICONS.refund :
      ICONS.clock;
  }

  if (byId("txmStatus")) {
    byId("txmStatus").textContent = status.label;
    byId("txmStatus").className = `txm-status ${status.cls}`;
  }

  if (byId("txmTitle")) byId("txmTitle").textContent = title;
  if (byId("txmAmount")) byId("txmAmount").textContent = formatNaira(tx.amount);

  if (byId("txmRecipient"))
    byId("txmRecipient").textContent =
      meta.phone || tx.recipient || tx.phone || "—";

  if (byId("txmReference"))
    byId("txmReference").textContent =
      tx.reference || tx.transaction_reference ||
      tx.transactionReference || tx.id || "—";

  if (byId("txmDate"))
    byId("txmDate").textContent = formatDateTimeFull(getCreatedAt(tx));

  if (byId("txmType")) byId("txmType").textContent = title;

  if (byId("txmNetwork"))
    byId("txmNetwork").textContent =
      meta.network_name || meta.network || tx.network || "—";

  if (byId("txmRemark"))
    byId("txmRemark").textContent =
      tx.description || status.label;

  fillElectricityFields(tx);

  modal.classList.remove("hidden");
  if (modalTimer) clearTimeout(modalTimer);

  requestAnimationFrame(() => modal.classList.add("show"));
  document.body.style.overflow = "hidden";
}

function closeTxModal() {
  const modal = byId("txModal");
  if (!modal) return;

  modal.classList.remove("show");
  document.body.style.overflow = "";

  if (modalTimer) clearTimeout(modalTimer);

  modalTimer = setTimeout(() => {
    modal.classList.add("hidden");
    currentTx = null;
  }, 260);
}

if (byId("txmClose"))
  byId("txmClose").addEventListener("click", closeTxModal);

if (byId("txmDone"))
  byId("txmDone").addEventListener("click", closeTxModal);

if (byId("txModal")) {
  byId("txModal").addEventListener("click", event => {
    if (event.target === byId("txModal")) closeTxModal();
  });
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && byId("txModal") &&
      !byId("txModal").classList.contains("hidden")) {
    closeTxModal();
  }
});

// ============================================================
// COPY REFERENCE
// ============================================================

if (byId("txmCopy")) {
  byId("txmCopy").addEventListener("click", async () => {
    if (!currentTx) return;

    const reference = currentTx.reference ||
      currentTx.transaction_reference ||
      currentTx.transactionReference || currentTx.id;

    if (!reference) return;

    try {
      await copyText(reference);
      byId("txmCopy").textContent = "Copied ✓";

      setTimeout(() => {
        if (byId("txmCopy")) byId("txmCopy").textContent = "Copy";
      }, 1500);
    } catch {
      window.prompt("Copy transaction reference:", reference);
    }
  });
}

// ============================================================
// SHARE RECEIPT
// ============================================================

function receiptText(tx) {
  const meta = getMetadata(tx);
  const lines = [
    "SHATOVA — TRANSACTION RECEIPT",
    "--------------------------------",
    `Transaction: ${friendlyTitle(tx)}`,
    `Amount: ${formatNaira(tx.amount)}`,
    `Status: ${statusInfo(tx).label}`,
    `Reference: ${tx.reference || tx.transaction_reference || tx.id || "—"}`,
    `Date: ${formatDateTimeFull(getCreatedAt(tx))}`
  ];

  if (meta.phone || tx.phone)
    lines.push(`Recipient: ${meta.phone || tx.phone}`);

  if (isElectricityTx(tx)) {
    const e = getElectricityReceipt(tx);
    lines.push(
      `Disco: ${e.disco || "—"}`,
      `Meter: ${e.meter || "—"}`,
      `Customer: ${e.customer || "—"}`,
      `Address: ${e.address || "—"}`,
      `Token: ${e.token || "Not available in transaction data"}`,
      `Units: ${e.units ? `${e.units} kWh` : "—"}`
    );
  }

  lines.push("", "Thank you for using Shatova.");
  return lines.join("\n");
}

if (byId("txmShare")) {
  byId("txmShare").addEventListener("click", async () => {
    if (!currentTx) return;

    const text = receiptText(currentTx);

    if (navigator.share) {
      try {
        await navigator.share({ title: "Shatova Receipt", text });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }

    try {
      await copyText(text);
      alert("Receipt copied. You can now paste and share it.");
    } catch {
      window.prompt("Copy your receipt:", text);
    }
  });
}

// ============================================================
// PRINT RECEIPT — ESCAPED VALUES, INCLUDING ELECTRICITY DETAILS
// ============================================================

function printReceipt(tx) {
  const popup = window.open("", "_blank", "width=480,height=720");

  if (!popup) {
    alert("Please allow pop-ups to print your receipt.");
    return;
  }

  const meta = getMetadata(tx);
  const electricity = isElectricityTx(tx);
  const e = getElectricityReceipt(tx);
  const status = statusInfo(tx);

  const rows = [
    ["Transaction", friendlyTitle(tx)],
    ["Status", status.label],
    ["Reference", tx.reference || tx.transaction_reference || tx.id || "—"],
    ["Date", formatDateTimeFull(getCreatedAt(tx))],
    ["Recipient", meta.phone || tx.phone || tx.recipient || "—"]
  ];

  if (electricity) {
    rows.push(
      ["Electricity Provider", e.disco || "—"],
      ["Meter Number", e.meter || "—"],
      ["Customer Name", e.customer || "—"],
      ["Address", e.address || "—"],
      ["Token", e.token || "Not available in transaction data"],
      ["Units", e.units ? `${e.units} kWh` : "—"]
    );
  } else {
    rows.push([
      "Network",
      meta.network_name || meta.network || tx.network || "—"
    ]);
  }

  rows.push(["Description", tx.description || "—"]);

  const htmlRows = rows.map(([label, value]) => `
    <div class="row">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value">${escapeHtml(value)}</span>
    </div>
  `).join("");

  popup.document.open();
  popup.document.write(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Shatova Transaction Receipt</title>
      <style>
        * { box-sizing: border-box; }
        body {
          font-family: Arial, sans-serif;
          color: #111827;
          max-width: 420px;
          margin: 0 auto;
          padding: 24px;
          background: white;
        }
        .header {
          text-align: center;
          padding-bottom: 18px;
          border-bottom: 2px dashed #d1d5db;
        }
        .brand { font-size: 26px; font-weight: 900; color: #0a4534; }
        .subtitle { color: #64748b; font-size: 12px; margin-top: 5px; }
        .amount {
          text-align: center;
          font-size: 29px;
          font-weight: 800;
          margin-top: 22px;
        }
        .status {
          text-align: center;
          font-size: 12px;
          font-weight: bold;
          margin: 10px 0 22px;
        }
        .success { color: #047857; }
        .failed { color: #b91c1c; }
        .pending { color: #92400e; }
        .refunded { color: #475569; }
        .row {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          padding: 10px 0;
          border-bottom: 1px solid #e5e7eb;
          font-size: 12px;
          break-inside: avoid;
        }
        .label { color: #64748b; flex: 0 0 40%; }
        .value { font-weight: 600; text-align: right; overflow-wrap: anywhere; }
        .footer {
          text-align: center;
          color: #64748b;
          font-size: 11px;
          margin-top: 24px;
          padding-top: 15px;
          border-top: 2px dashed #d1d5db;
        }
        @media print {
          body { padding: 0; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="brand">SHATOVA</div>
        <div class="subtitle">Transaction Receipt</div>
      </div>
      <div class="amount">${escapeHtml(formatNaira(tx.amount))}</div>
      <div class="status ${status.cls}">${escapeHtml(status.label)}</div>
      ${htmlRows}
      <div class="footer">Thank you for using Shatova.</div>
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.print();
          }, 400);
        };
      <\/script>
    </body>
    </html>
  `);
  popup.document.close();
}

if (byId("txmPrint")) {
  byId("txmPrint").addEventListener("click", () => {
    if (currentTx) printReceipt(currentTx);
  });
}

// ============================================================
// FILTER SHEET
// ============================================================

function syncFilterSheet() {
  const body = byId("filterBody");
  if (!body) return;

  body.querySelectorAll(".filter-card").forEach(card => {
    card.classList.toggle("active", card.dataset.value === draftCategory);
  });
}

function openFilterSheet() {
  const sheet = byId("filterSheet");
  if (!sheet) return;

  draftCategory = state.filters.category;
  syncFilterSheet();
  sheet.classList.remove("hidden");

  requestAnimationFrame(() => sheet.classList.add("show"));
  document.body.style.overflow = "hidden";
}

function closeFilterSheet() {
  const sheet = byId("filterSheet");
  if (!sheet) return;

  sheet.classList.remove("show");
  document.body.style.overflow = "";

  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => sheet.classList.add("hidden"), 260);
}

if (byId("txFilterFab"))
  byId("txFilterFab").addEventListener("click", openFilterSheet);

if (byId("filterClose"))
  byId("filterClose").addEventListener("click", closeFilterSheet);

if (byId("filterSheet")) {
  byId("filterSheet").addEventListener("click", event => {
    if (event.target === byId("filterSheet")) closeFilterSheet();
  });
}

if (byId("filterBody")) {
  byId("filterBody").addEventListener("click", event => {
    const card = event.target.closest(".filter-card");
    if (!card) return;

    draftCategory = card.dataset.value;
    syncFilterSheet();
  });
}

function syncFilterControls() {
  if (byId("txSearchInput"))
    byId("txSearchInput").value = state.search;

  if (byId("txSearchClear"))
    byId("txSearchClear").classList.toggle("hidden", !state.search);

  if (byId("txStatusChips")) {
    byId("txStatusChips").querySelectorAll(".tx-chip").forEach(chip => {
      chip.classList.toggle("active",
        chip.dataset.status === state.filters.status);
    });
  }

  const labels = {
    all: "All Types",
    deposits: "Deposits",
    withdrawals: "Withdrawals",
    refunded: "Refunded",
    transfers: "Transfers"
  };

  if (byId("typeDropdownLabel"))
    byId("typeDropdownLabel").textContent =
      labels[state.filters.category] || "All Types";
}

if (byId("filterReset")) {
  byId("filterReset").addEventListener("click", () => {
    state.filters.category = "all";
    state.filters.status = "all";
    state.search = "";
    draftCategory = "all";

    syncFilterControls();
    syncFilterSheet();
    closeFilterSheet();
    applyFilters();
  });
}

if (byId("filterApply")) {
  byId("filterApply").addEventListener("click", () => {
    state.filters.category = draftCategory;
    syncFilterControls();
    closeFilterSheet();
    applyFilters();
  });
}

// ============================================================
// STATUS CHIPS AND TYPE DROPDOWN
// ============================================================

if (byId("txStatusChips")) {
  byId("txStatusChips").addEventListener("click", event => {
    const chip = event.target.closest(".tx-chip");
    if (!chip) return;

    state.filters.status = chip.dataset.status || "all";
    syncFilterControls();
    applyFilters();
  });
}

if (byId("typeDropdownBtn")) {
  byId("typeDropdownBtn").addEventListener("click", () => {
    const categories = [
      "all", "deposits", "withdrawals", "refunded", "transfers"
    ];

    const index = categories.indexOf(state.filters.category);
    state.filters.category = categories[(index + 1) % categories.length];
    draftCategory = state.filters.category;

    syncFilterControls();
    applyFilters();
  });
}

// ============================================================
// SEARCH
// ============================================================

if (byId("txSearchInput")) {
  byId("txSearchInput").addEventListener("input", event => {
    state.search = event.target.value || "";

    if (byId("txSearchClear"))
      byId("txSearchClear").classList.toggle("hidden", !state.search);

    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 180);
  });
}

if (byId("txSearchClear")) {
  byId("txSearchClear").addEventListener("click", () => {
    state.search = "";
    if (byId("txSearchInput")) byId("txSearchInput").value = "";

    byId("txSearchClear").classList.add("hidden");
    applyFilters();
  });
}

if (byId("pgPrev"))
  byId("pgPrev").addEventListener("click", () => changePage(-1));

if (byId("pgNext"))
  byId("pgNext").addEventListener("click", () => changePage(1));

// ============================================================
// FETCH TRANSACTIONS
// ============================================================

function extractTransactions(json) {
  const candidates = [
    json?.data?.transactions,
    json?.data?.rows,
    json?.transactions,
    json?.data?.data?.transactions,
    json?.data?.items,
    json?.items
  ];

  return candidates.find(Array.isArray) || null;
}

async function fetchAllTransactions() {
  const skeleton = byId("txSkeleton");
  const container = byId("txReal");
  const empty = byId("txEmpty");

  if (skeleton) skeleton.classList.remove("hidden");
  if (container) container.classList.add("hidden");
  if (empty) empty.classList.add("hidden");

  try {
    if (!API_BASE) {
      throw new Error("window.API_BASE is not configured.");
    }

    const params = new URLSearchParams({
      limit: "200",
      offset: "0",
      type: "all"
    });

    const response = await fetch(
      `${API_BASE}/wallet/transactions?${params.toString()}`,
      {
        method: "GET",
        headers: authHeaders(),
        credentials: "include"
      }
    );

    if (response.status === 401 || response.status === 403) {
      redirectToLogin();
      return;
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.success === false) {
      throw new Error(json.message || `Request failed (${response.status}).`);
    }

    const transactions = extractTransactions(json);

    if (!transactions) {
      throw new Error("The transactions API returned an unexpected response.");
    }

    state.allTransactions = transactions;
    state.search = state.search || "";

    if (skeleton) skeleton.classList.add("hidden");
    syncFilterControls();
    applyFilters();

  } catch (error) {
    console.error("[Shatova transactions]", error);

    if (skeleton) skeleton.classList.add("hidden");
    if (container) container.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");

    if (byId("txEmptyTitle"))
      byId("txEmptyTitle").textContent = "Could not load transactions";

    if (byId("txEmptyText"))
      byId("txEmptyText").textContent =
        error.message || "Please check your connection and try again.";
  }
}

// ============================================================
// INITIALIZE
// ============================================================

async function initTransactions() {
  if (!getToken()) {
    redirectToLogin();
    return;
  }

  await fetchAllTransactions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTransactions, { once: true });
} else {
  initTransactions();
}
```
