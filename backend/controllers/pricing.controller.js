// controllers/pricing.controller.js
// ============================================================
// Admin pricing console — reads from data_plans
// + write endpoint to set sell_price / is_active per plan
// ============================================================

import { query } from '../config/database.js';
import { fetchAllProductsForPricing } from '../services/datashop.service.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, payload: null };

/* ============================================================
   GET /admin/pricing/datashop
   ------------------------------------------------------------
   Kept 100% identical to your original — this is just the
   DataShop-side catalogue for reference. You don't use it
   from the pricing page.
   ============================================================ */
export async function getDatashopPricing(req, res) {
  try {
    const force = String(req.query.refresh || '') === 'true';
    const now = Date.now();

    let payload = cache.payload;
    if (force || !payload || now - cache.at > CACHE_TTL_MS) {
      const fresh = await fetchAllProductsForPricing();
      payload = {
        products:   fresh.products,
        errors:     fresh.errors,
        fetched_at: new Date().toISOString(),
      };
      cache = { at: now, payload };
    }

    let localMap = new Map();
    try {
      const { rows } = await query(
        `SELECT plan_id AS code, sell_price, cost_price, is_active
           FROM data_plans`
      );
      localMap = new Map(rows.map((r) => [String(r.code), r]));
    } catch (_) { /* data_plans missing — skip */ }

    const products = payload.products.map((p) => {
      const local = localMap.get(String(p.code)) || null;
      const selling = local ? Number(local.sell_price) : null;
      const margin  = selling != null ? selling - p.cost_price : null;
      const marginPct = selling && selling > 0
        ? Math.round(((selling - p.cost_price) / selling) * 1000) / 10
        : null;
      return {
        ...p,
        selling_price: selling,
        margin,
        margin_pct: marginPct,
        is_active: local ? local.is_active : null,
      };
    });

    const by_category = products.reduce((acc, p) => {
      acc[p.category] = (acc[p.category] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      success: true,
      data: {
        products,
        summary: {
          total: products.length,
          by_category,
          errors: payload.errors,
          fetched_at: payload.fetched_at,
        },
      },
    });
  } catch (err) {
    console.error('[pricing] getDatashopPricing:', err);
    return res.status(502).json({
      success: false,
      message: err.message || 'Could not fetch Datashop pricing.',
    });
  }
}

/* ============================================================
   POST /admin/pricing/refresh   (unchanged)
   ============================================================ */
export async function forceRefreshPricing(req, res) {
  try {
    cache = { at: 0, payload: null };
    const fresh = await fetchAllProductsForPricing();
    cache = {
      at: Date.now(),
      payload: {
        products:   fresh.products,
        errors:     fresh.errors,
        fetched_at: new Date().toISOString(),
      },
    };
    return res.json({
      success: true,
      data: {
        count:      fresh.products.length,
        errors:     fresh.errors,
        fetched_at: cache.payload.fetched_at,
      },
    });
  } catch (err) {
    console.error('[pricing] forceRefreshPricing:', err);
    return res.status(502).json({ success: false, message: err.message });
  }
}

/* ============================================================
   GET /admin/pricing/debug   (unchanged)
   ============================================================ */
export async function debugDatashop(req, res) {
  try {
    const {
      listServices,
      listProviders,
      listProducts,
    } = await import('../services/datashop.service.js');

    const out = {
      services:    null,
      providers:   null,
      products:    null,
      productsAll: null,
      errors:      {},
      samples:     {},
    };

    try { out.services = await listServices(); }
    catch (e) { out.errors.services = e.message; }

    try { out.providers = await listProviders('data'); }
    catch (e) { out.errors.providers = e.message; }

    try {
      out.products = await listProducts({ service: 'data' });
      if (Array.isArray(out.products) && out.products[0]) {
        out.samples['data_0'] = out.products[0];
        out.samples['data_keys'] = Object.keys(out.products[0]);
      }
    } catch (e) { out.errors.products = e.message; }

    try {
      out.productsAll = await listProducts({});
      if (Array.isArray(out.productsAll) && out.productsAll[0]) {
        out.samples['all_0'] = out.productsAll[0];
        out.samples['all_keys'] = Object.keys(out.productsAll[0]);
        out.samples['all_count'] = out.productsAll.length;
      }
    } catch (e) { out.errors.productsAll = e.message; }

    return res.json({ success: true, data: out });
  } catch (err) {
    console.error('[pricing] debugDatashop:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   GET /admin/data-plans
   ------------------------------------------------------------
   Returns all plans from data_plans in the shape the pricing
   page (pricing.html) expects.
   ============================================================ */
export async function getDataPlans(req, res) {
  try {
    const { rows } = await query(
      `SELECT plan_id, provider, category, display_name,
              validity, description,
              cost_price, sell_price, profit,
              is_active, sort_order, updated_at
         FROM data_plans
        ORDER BY provider ASC, category ASC, cost_price ASC`
    );

    const data = rows.map((r) => ({
      plan_id:      r.plan_id,
      provider:     r.provider,
      category:     r.category,
      display_name: r.display_name,
      validity:     r.validity || '',
      description:  r.description || '',
      cost_price:   Number(r.cost_price || 0),
      sell_price:   Number(r.sell_price || 0),
      profit:       Number(r.profit || 0),
      is_active:    r.is_active === true,
      sort_order:   Number(r.sort_order || 0),
      updated_at:   r.updated_at,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[pricing] getDataPlans:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Could not load data plans',
    });
  }
}

/* ============================================================
   PATCH /admin/data-plans/:plan_id
   ------------------------------------------------------------
   Updates sell_price (and optionally is_active) for one plan.
   The plan MUST already exist — we do not INSERT partial rows.
   Body: { sell_price: 380, is_active: true }
   ============================================================ */
export async function updateDataPlan(req, res) {
  try {
    const planId = String(req.params.plan_id || '').trim();
    if (!planId) {
      return res.status(400).json({ success: false, message: 'plan_id is required' });
    }

    const body = req.body || {};
    const hasPrice  = body.sell_price   !== undefined;
    const hasActive = body.is_active    !== undefined;

    if (!hasPrice && !hasActive) {
      return res.status(400).json({
        success: false,
        message: 'Provide sell_price and/or is_active',
      });
    }

    let sellPrice = null;
    if (hasPrice) {
      sellPrice = Number(body.sell_price);
      if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: 'sell_price must be a positive number',
        });
      }
    }

    const sets   = [];
    const params = [];
    const push   = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (hasPrice)  push('sell_price', sellPrice);
    if (hasActive) push('is_active', !!body.is_active);
    sets.push('updated_at = NOW()');
    params.push(planId);

    const { rows } = await query(
      `UPDATE data_plans SET ${sets.join(', ')}
        WHERE plan_id = $${params.length}
        RETURNING plan_id, provider, category, display_name,
                  cost_price, sell_price, profit, is_active, updated_at`,
      params
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: `Plan "${planId}" not found in data_plans`,
      });
    }

    console.log(`[pricing] updated ${planId}:`, rows[0]);

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[pricing] updateDataPlan:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Could not update plan',
    });
  }
}

export default {
  getDatashopPricing,
  forceRefreshPricing,
  debugDatashop,
  getDataPlans,
  updateDataPlan,
};
