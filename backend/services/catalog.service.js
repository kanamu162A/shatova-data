// services/catalog.service.js
// ============================================================
// Shatova — Catalog Sync Service
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

function displayName(product) {
  if (product.description && String(product.description).length > 3) return product.description;
  if (product.name && String(product.name).length > 3) return product.name;
  const qty = product.quantity || '';
  const validity = product.validity || '';
  const parts = [qty, validity].filter(Boolean);
  return parts.length ? parts.join(' ╖ ') : (product.product_name || product.plan_id || 'Data plan');
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
  if (products.length) {
    console.log(`[catalog] ${provider} sample:`, JSON.stringify(products[0], null, 2));
  }

  if (!Array.isArray(products) || !products.length) {
    console.warn(`[catalog] ${provider}: no products returned`);
    return result;
  }

  for (const p of products) {
    try {
      const planId = extractPlanId(p);
      if (!planId) {
        console.warn(`[catalog] ${provider}: skipping item without plan_id`);
        continue;
      }

      const providerName = String(p.provider || provider).toUpperCase();
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
            cost_price, sell_price, profit, is_active, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 0, $8, 0, NOW(), NOW())
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