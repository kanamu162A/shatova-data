// services/catalog.service.js
// ============================================================
// Shatova — Catalog Sync Service (v4 — professional display)
//   ⭐ display_name: "2GB · 1 Month", "500MB · 2 Days"
//   ⭐ Validity labels: 1 Day / 2 Days / 1 Week / 2 Weeks /
//                        1 Month / 3 Months — but ONLY when
//                        DataShop's raw validity is exact.
//   ⭐ Never fabricates validity. What DataShop says is
//      what the customer sees (converted to the shortest
//      accurate label).
//   ⭐ Sizes: 1024MB → 1GB, 500MB → 500MB, 1.5GB → 1.5GB
//   ⭐ Provider names normalized to DB CHECK values.
//   ⭐ profit column removed from INSERT (generated).
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

/* ─────────────────────────────────────────────────────────────
   SIZE FORMATTER
   → "1024MB" becomes "1GB"
   → "500MB" stays "500MB"
   → "1.5GB" stays "1.5GB"
   → "2000MB" becomes "2GB" only when divisible by 1024
   ───────────────────────────────────────────────────────────── */
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
   VALIDITY FORMATTER — the professional core
   Converts raw DataShop validity → the shortest accurate label.

   1 day → "1 Day"          2 days → "2 Days"
   7 days → "1 Week"        14 days → "2 Weeks"
   21 days → "21 Days"      30 days → "1 Month"
   60 days → "2 Months"     90 days → "3 Months"
   1 month → "1 Month"      2 months → "2 Months"
   1 week  → "1 Week"       2 weeks → "2 Weeks"

   ⚠ Never changes the number. Never fabricates.
   ⚠ 21 days is NOT "1 Month". It's 21 days.
   ───────────────────────────────────────────────────────────── */
function formatValidity(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';

  // Normalize weeks → days
  if (raw.includes('week')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return formatValidityFromDays(n * 7);
  }

  // Normalize months → days
  if (raw.includes('month')) {
    const m = raw.match(/(\d+)/);
    const n = m ? Number(m[1]) : 1;
    return formatValidityFromDays(n * 30);
  }

  // Already in days
  if (raw.includes('day')) {
    const m = raw.match(/(\d+)/);
    if (!m) return String(v).trim();
    return formatValidityFromDays(Number(m[1]));
  }

  // Bare number → days
  const numMatch = raw.match(/^(\d+)$/);
  if (numMatch) return formatValidityFromDays(Number(numMatch[1]));

  return String(v).trim();
}

/* Convert a day count to the most readable label */
function formatValidityFromDays(days) {
  const d = Number(days) || 0;
  if (d <= 0) return '';

  if (d === 1)  return '1 Day';
  if (d === 7)  return '1 Week';
  if (d === 14) return '2 Weeks';
  if (d === 30) return '1 Month';
  if (d === 60) return '2 Months';
  if (d === 90) return '3 Months';
  if (d === 180) return '6 Months';
  if (d === 365) return '1 Year';

  // Fall back to exact day count — never round
  return `${d} ${d === 1 ? 'Day' : 'Days'}`;
}

/* ─────────────────────────────────────────────────────────────
   DISPLAY NAME
   Composes: "2GB · 1 Month", "500MB · 2 Days", "1.5GB · 1 Week"
   ───────────────────────────────────────────────────────────── */
function displayName(product) {
  const size     = formatSize(product.quantity || product.data_size || product.size);
  const validity = formatValidity(product.validity || product.duration);

  if (size && validity) return `${size} · ${validity}`;
  if (size)             return size;
  if (validity)         return validity;

  // Last resort — clean up DataShop's description
  const desc = String(product.description || '').trim();
  if (desc) {
    return desc
      .replace(/^Get\s+/i, '')
      .replace(/\s*for\s*₦[\d,]+\.?/i, '')
      .replace(/\.$/, '');
  }

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
