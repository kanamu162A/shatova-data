// services/catalog.service.js
// ============================================================
// Shatova — Catalog Sync Service (v6 — month-bucket validity)
//   ⭐ display_name = "Size · Validity" only (no description)
//   ⭐ Validity:
//        1 day    → 1 Day
//        2–6 days → N Days
//        7–13 days → 1 Week
//        14–19 days → 2 Weeks
//        >= 20 days → 1 Month (bucket: 20–45d)
//        >= 46 days → 2 Months (46–75d)
//        >= 76 days → 3 Months (76–120d)
//        >= 121 days → 6 Months (121–200d)
//        >= 201 days → 1 Year
//   ⭐ Sizes: 1024MB → 1GB, 500MB → 500MB
//   ⭐ Provider names normalized to DB CHECK values
//   ⭐ profit column NOT in INSERT (generated)
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
   VALIDITY → friendly label
   Rule: >= 20 days is a Month (bucketed)
   ───────────────────────────────────────────────────────────── */
function formatValidityFromDays(days) {
  const d = Number(days) || 0;
  if (d <= 0) return '';

  if (d === 1)              return '1 Day';
  if (d < 7)                return `${d} Days`;
  if (d < 14)               return '1 Week';
  if (d < 20)               return '2 Weeks';
  if (d <= 45)              return '1 Month';    // 20–45 days
  if (d <= 75)              return '2 Months';   // 46–75 days
  if (d <= 120)             return '3 Months';   // 76–120 days
  if (d <= 200)             return '6 Months';   // 121–200 days
  return '1 Year';                               // 201+ days
}

/* Parse DataShop's raw validity into days, then format */
function formatValidity(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';

  if (raw.includes('week')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return formatValidityFromDays(n * 7);
  }
  if (raw.includes('month')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return formatValidityFromDays(n * 30);
  }
  if (raw.includes('day')) {
    const m = raw.match(/(\d+)/);
    if (!m) return String(v).trim();
    return formatValidityFromDays(Number(m[1]));
  }
  const numMatch = raw.match(/^(\d+)$/);
  if (numMatch) return formatValidityFromDays(Number(numMatch[1]));

  return String(v).trim();
}

/* display_name = "1GB · 1 Month" — no description, no marketing text */
function displayName(product) {
  const size     = formatSize(product.quantity || product.data_size || product.size);
  const validity = formatValidity(product.validity || product.duration);

  if (size && validity) return `${size} · ${validity}`;
  if (size)             return size;
  if (validity)         return validity;

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
      const name         = displayName(p);
      const validity     = extractValidity(p);
      const cost         = extractPrice(p);
      const isActive     = p.available !== false;

      if (!cost || cost <= 0) {
        console.warn(`[catalog] ${provider}: skipping ${planId} — zero price`);
        continue;
      }

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
        [providerName, category, planId, name, validity, p.description || '', cost, isActive]
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
