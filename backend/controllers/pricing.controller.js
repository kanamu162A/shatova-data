// controllers/pricing.controller.js
// ============================================================
// Admin pricing console — Datashop live costs + margin
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

    /* Join with local products table (silent if missing) */
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
   ------------------------------------------------------------
   TEMPORARY — exposes raw Datashop responses so we can see
   exactly what shape the API returns. Remove after debugging.
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