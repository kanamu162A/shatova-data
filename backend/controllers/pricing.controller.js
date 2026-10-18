// controllers/pricing.controller.js
// ============================================================
// Admin pricing console — Datashop live costs + margin
// + v12: write endpoint to set sell_price / is_active per plan
// ============================================================

import { query } from '../config/database.js';
import { fetchAllProductsForPricing } from '../services/datashop.service.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, payload: null };

/* ============================================================
   GET /admin/pricing/datashop
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
        `SELECT product_code AS code,
                selling_price,
                cost_price,
                is_active
           FROM products
          WHERE product_code IS NOT NULL`
      );
      localMap = new Map(rows.map((r) => [String(r.code), r]));
    } catch (_) { /* products table doesn't exist yet */ }

    const products = payload.products.map((p) => {
      const local = localMap.get(String(p.code)) || null;
      const selling = local ? Number(local.selling_price) : null;
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
   POST /admin/pricing/refresh
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
   GET /admin/pricing/debug
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
   POST /admin/pricing/product/:code
   ------------------------------------------------------------
   Set a sell price (and optionally toggle availability) for one
   plan in data_plans. This is what tells Shatova how much to
   charge the customer, independently of the live DataShop cost.

   Body: { selling_price: 380, is_active: true }
   ============================================================ */
export async function setProductSellingPrice(req, res) {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) {
      return res.status(400).json({ success: false, message: 'plan code is required' });
    }

    const body = req.body || {};
    const hasPrice  = body.selling_price !== undefined;
    const hasActive = body.is_active !== undefined;

    if (!hasPrice && !hasActive) {
      return res.status(400).json({
        success: false,
        message: 'Provide selling_price and/or is_active',
      });
    }

    let sellingPrice = null;
    if (hasPrice) {
      sellingPrice = Number(body.selling_price);
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
        return res.status(400).json({
          success: false,
          message: 'selling_price must be a non-negative number',
        });
      }
    }

    /* Upsert into data_plans.
       - If the row exists: update sell_price / is_active.
       - If not: insert a minimal row so the override is stored.
       We rely on the DB default for any missing required columns. */
    if (hasPrice && hasActive) {
      await query(
        `INSERT INTO data_plans (plan_id, sell_price, is_active, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (plan_id) DO UPDATE
           SET sell_price = EXCLUDED.sell_price,
               is_active  = EXCLUDED.is_active,
               updated_at = NOW()`,
        [code, sellingPrice, !!body.is_active]
      );
    } else if (hasPrice) {
      await query(
        `INSERT INTO data_plans (plan_id, sell_price, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (plan_id) DO UPDATE
           SET sell_price = EXCLUDED.sell_price,
               updated_at = NOW()`,
        [code, sellingPrice]
      );
    } else {
      await query(
        `INSERT INTO data_plans (plan_id, is_active, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (plan_id) DO UPDATE
           SET is_active  = EXCLUDED.is_active,
               updated_at = NOW()`,
        [code, !!body.is_active]
      );
    }

    const { rows } = await query(
      `SELECT plan_id, sell_price, is_active
         FROM data_plans WHERE plan_id = $1 LIMIT 1`,
      [code]
    );

    console.log(`[pricing] setProductSellingPrice ${code} →`, rows[0]);

    return res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    console.error('[pricing] setProductSellingPrice:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Could not update selling price',
    });
  }
}

export default {
  getDatashopPricing,
  forceRefreshPricing,
  debugDatashop,
  setProductSellingPrice,
};
