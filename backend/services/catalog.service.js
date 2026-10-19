// services/catalog.service.js
// ============================================================
// Shatova — Catalog Sync Service (v7 — permanent 21d→30d)
//   ⭐ 21-day plans are stored as 30 days and shown as "1 Month"
//   ⭐ Reruns are safe — each cron tick re-applies the rule
//   ⭐ Description never shown to customers
//   ⭐ profit column NOT written (generated)
//   ⭐ Provider names normalized to DB CHECK values
// ============================================================

import { query } from '../config/database.js';
import * as datashop from './datashop.service.js';

const PROVIDERS = ['MTN', 'Airtel', 'Glo', '9mobile'];

function providerKey(name = '') {
  const k = String(name).toLowerCase();
  if (k.includes('mtn'))    return 'mtn';
  if (k.includes('airtel')) return 'airtel';
  if (k.includes('glo'))    return 'glo';
  if (k.includes('9mobile') || k.includes('etisalat') || k.includes('t2')) return 't2';
  return k;
}

function mapProvider(raw, fallback = 'MTN') {
  const k = String(raw || '').toLowerCase().trim();
  if (k.includes('mtn'))    return 'MTN';
  if (k.includes('airtel')) return 'Airtel';
  if (k.includes('glo'))    return 'Glo';
  if (k.includes('9mobile') || k.includes('etisalat') || k === 't2' || k.includes('t2')) return 'T2';
  return fallback;
}

function deriveCategory(product) {
  const cat = String(product.category || product.sub_category || '').trim();
  if (cat) return cat.toUpperCase();

  const n = String(product.product_name || product.name || product.plan_id || product.id || '').toLowerCase();
  if (n.includes('share'))     return 'MTN SHARE';
  if (n.includes('social'))    return 'SOCIAL BUNDLE';
  if (n.includes('sme'))       return 'SME';
  if (n.includes('gifting'))   return 'GIFTING';
  if (n.includes('corporate')) return 'CORPORATE';
  if (n.includes('always'))    return 'MTN ALWAYS ON';
  if (n.includes('fibre') || n.includes('fiber')) return 'MTN FIBRE-X';
  if (n.includes('mobile'))    return 'MTN MOBILE DATA';
  return 'MOBILE DATA';
}

/* Format raw size → "1GB", "500MB", "1.5GB" */
function formatSize(qty) {
  const raw = String(qty || '').trim();
  if (!raw) return '';

  if (/^\d+(\.\d+)?\s*(gb|mb)$/i.test(raw)) {
    const m = raw.match(/^(\d+(\.\d+)?)\s*(gb|mb)$/i);
    const n = Number(m[1]);
    const unit = m[3].toLowerCase();
    if (unit === 'mb' && n >= 1024 && n % 1024 === 0) return `${n / 1024}GB`;
    return `${n}${unit.toUpperCase()}`;
  }

  const numMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(mb|gb|m|g)?$/i);
  if (numMatch) {
    const n = Number(numMatch[1]);
    const unit = (numMatch[2] || 'mb').toLowerCase();
    if (unit === 'gb' || unit === 'g') return `${n}GB`;
    if (n >= 1024 && n % 1024 === 0)   return `${n / 1024}GB`;
    return `${n}MB`;
  }

  return raw;
}

/* ─────────────────────────────────────────────────────────────
   VALIDITY → normalized to DB stored value + display label
   Rule: any plan whose DataShop validity is 20–45 days
         is stored as "30 days" and displayed as "1 Month".
   This runs on EVERY cron tick, so SQL-only fixes aren't
   required — the code enforces the rule permanently.
   ───────────────────────────────────────────────────────────── */
function normalizeValidity(rawValidity) {
  const raw = String(rawValidity || '').trim().toLowerCase();
  if (!raw) return { stored: '', label: '' };

  // Weeks
  if (raw.includes('week')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return daysToValidity(n * 7);
  }
  // Months
  if (raw.includes('month')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return daysToValidity(n * 30);
  }
  // Days
  if (raw.includes('day')) {
    const m = raw.match(/(\d+)/);
    if (!m) return { stored: String(rawValidity).trim(), label: String(rawValidity).trim() };
    return daysToValidity(Number(m[1]));
  }
  // Bare number
  const numMatch = raw.match(/^(\d+)$/);
  if (numMatch) return daysToValidity(Number(numMatch[1]));

  return { stored: String(rawValidity).trim(), label: String(rawValidity).trim() };
}

/* Convert day count → { stored, label } */
function daysToValidity(days) {
  const d = Number(days) || 0;
  if (d <= 0) return { stored: '', label: '' };

  // ⭐ 20–45 days → stored as 30 days, shown as 1 Month
  if (d >= 20 && d <= 45) {
    return { stored: '30 days', label: '1 Month' };
  }
  // 46–75 → 2 Months
  if (d >= 46 && d <= 75) {
    return { stored: '60 days', label: '2 Months' };
  }
  // 76–120 → 3 Months
  if (d >= 76 && d <= 120) {
    return { stored: '90 days', label: '3 Months' };
  }
  // 121–200 → 6 Months
  if (d >= 121 && d <= 200) {
    return { stored: '180 days', label: '6 Months' };
  }
  // 201+ → 1 Year
  if (d >= 201) {
    return { stored: '365 days', label: '1 Year' };
  }
  // 14–19 → 2 Weeks
  if (d >= 14 && d < 20) {
    return { stored: `${d} days`, label: '2 Weeks' };
  }
  // 7–13 → 1 Week
  if (d >= 7 && d < 14) {
    return { stored: '7 days', label: '1 Week' };
  }
  // 1–6 → N Days
  return {
    stored: `${d} ${d === 1 ? 'day' : 'days'}`,
    label:  `${d} ${d === 1 ? 'Day' : 'Days'}`,
  };
}

/* display_name = "1GB · 1 Month" — no description, no marketing text */
function displayName(product, validityLabel) {
  const size = formatSize(product.quantity || product.data_size || product.size);
  const label = validityLabel || '';

  if (size && label) return `${size} · ${label}`;
  if (size)          return size;
  if (label)         return label;

  return product.product_name || product.plan_id || 'Data plan';
}

function extractPlanId(p) {
  return p.product_name || p.plan_id || p.id || p.code || p.product_code || p.slug || null;
}

function extractPrice(p) {
  return Number(p.fixed_price ?? p.price ?? p.amount ?? p.cost ?? p.retail_price ?? 0);
}

function extractValidity(p) {
  return p.validity || p.plan_validity || p.duration || '';
}

function extractQuantity(p) {
  return p.quantity || p.data_size || p.size || p.volume || '';
}

export async function syncDataProvider(provider) {
  const result = { provider, inserted: 0, updated: 0, error: null };

  let products = [];
  try {
    products = await datashop.listProducts({ service: 'data', provider });
  } catch (err) {
    result.error = err.message || 'Unknown error';
    console.error(`[catalog] ${provider} fetch failed:`, err.message);
    return result;
  }

  console.log(`[catalog] ${provider}: got ${products.length} products`);

  if (!Array.isArray(products) || !products.length) {
    console.warn(`[catalog] ${provider}: no products returned`);
    return result;
  }

  for (const p of products) {
    try {
      const planId = extractPlanId(p);
      if (!planId) continue;

      const providerName = mapProvider(p.provider || provider, mapProvider(provider));
      const category     = deriveCategory(p);
      const cost         = extractPrice(p);
      const isActive     = p.available !== false;

      if (!cost || cost <= 0) {
        console.warn(`[catalog] ${provider}: skipping ${planId} — zero price`);
        continue;
      }

      /* ⭐ Normalize validity from DataShop's raw value
           "21 days" → stored: "30 days", label: "1 Month" */
      const norm = normalizeValidity(extractValidity(p));
      const name = displayName(p, norm.label);

      const { rows } = await query(
        `INSERT INTO data_plans
           (provider, category, plan_id, display_name, validity, description,
            cost_price, sell_price, is_active, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 0, NOW(), NOW())
         ON CONFLICT (plan_id)
         DO UPDATE SET
           provider     = EXCLUDED.provider,
           category     = EXCLUDED.category,
           display_name = EXCLUDED.display_name,
           validity     = EXCLUDED.validity,
           description  = EXCLUDED.description,
           cost_price   = EXCLUDED.cost_price,
           is_active    = EXCLUDED.is_active,
           updated_at   = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [providerName, category, planId, name, norm.stored, p.description || '', cost, isActive]
      );

      if (rows[0]?.inserted) result.inserted++;
      else result.updated++;
    } catch (err) {
      console.error(`[catalog] ${provider} upsert failed:`, err.message);
    }
  }

  console.log(`[catalog] ${provider}: done — ${result.updated}U/${result.inserted}I`);
  return result;
}

export async function syncAllDataProviders() {
  const results = [];
  for (const provider of PROVIDERS) {
    results.push(await syncDataProvider(provider));
  }
  return results;
}

export async function syncAirtimeProvider(provider) {
  return { provider, margin_pct: 2, error: null };
}

export async function syncAllAirtimeProviders() {
  return PROVIDERS.map((p) => ({ provider: p, margin_pct: 2, error: null }));
}

export async function syncNow() {
  const startedAt = Date.now();
  const data = await syncAllDataProviders();
  return { ms: Date.now() - startedAt, data };
}
