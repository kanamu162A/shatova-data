// controllers/adminPricing.controller.js
// ============================================================
// Shatova — Admin Pricing (Data Plans)
//   ⭐ List all plans with cost + sell + profit
//   ⭐ Update sell_price / cost_price / is_active
//   ⭐ Bulk update sell prices
// ============================================================

import { query } from '../config/database.js';

/* ============================================================
   Helper — compute profit + margin from cost/sell
   ============================================================ */
function shapePlan(r) {
  const cost = Number(r.cost_price || 0);
  const sell = Number(r.sell_price || 0);
  return {
    plan_id:      r.plan_id,
    provider:     r.provider,
    category:     r.category,
    display_name: r.display_name,
    validity:     r.validity || '',
    cost_price:   cost,
    sell_price:   sell,
    profit:       Math.round((sell - cost) * 100) / 100,
    margin_pct:   cost > 0 ? Math.round(((sell - cost) / cost) * 10000) / 100 : 0,
    is_active:    r.is_active === true,
    updated_at:   r.updated_at,
  };
}

/* ============================================================
   GET /admin/data-plans
   Optional: ?network=MTN&category=SME&search=1gb
   ============================================================ */
export async function listDataPlans(req, res) {
  try {
    const params = [];
    const where  = [];

    const network  = String(req.query.network  || '').trim().toUpperCase();
    const category = String(req.query.category || '').trim().toUpperCase();
    const search   = String(req.query.search   || '').trim();

    if (network)  { params.push(network);  where.push(`UPPER(provider) = $${params.length}`); }
    if (category) { params.push(category); where.push(`UPPER(category) = $${params.length}`); }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(plan_id ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT plan_id, provider, category, display_name, validity,
              cost_price, sell_price, is_active, updated_at
         FROM data_plans
         ${whereSql}
         ORDER BY provider ASC, category ASC, cost_price ASC
         LIMIT 500`,
      params
    );

    const plans = rows.map(shapePlan);

    res.json({ success: true, data: { plans, total: plans.length } });
  } catch (err) {
    console.error('[adminPricing.listDataPlans]', err);
    res.status(500).json({ success: false, message: 'Could not load plans' });
  }
}

/* ============================================================
   PATCH /admin/data-plans/:planId
   Body: { sell_price?, cost_price?, is_active? }
   ============================================================ */
export async function updateDataPlan(req, res) {
  try {
    const planId = String(req.params.planId || '').trim();
    if (!planId) {
      return res.status(400).json({ success: false, message: 'planId required' });
    }

    const { sell_price, cost_price, is_active } = req.body || {};

    const sets   = [];
    const params = [];

    if (sell_price != null) {
      const n = Number(sell_price);
      if (isNaN(n) || n < 0 || n > 1_000_000) {
        return res.status(400).json({ success: false, message: 'Invalid sell_price' });
      }
      params.push(Math.round(n * 100) / 100);
      sets.push(`sell_price = $${params.length}`);
    }

    if (cost_price != null) {
      const n = Number(cost_price);
      if (isNaN(n) || n < 0 || n > 1_000_000) {
        return res.status(400).json({ success: false, message: 'Invalid cost_price' });
      }
      params.push(Math.round(n * 100) / 100);
      sets.push(`cost_price = $${params.length}`);
    }

    if (is_active != null) {
      params.push(Boolean(is_active));
      sets.push(`is_active = $${params.length}`);
    }

    if (!sets.length) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    sets.push(`updated_at = NOW()`);
    params.push(planId);

    const { rows } = await query(
      `UPDATE data_plans
          SET ${sets.join(', ')}
        WHERE plan_id = $${params.length}
        RETURNING plan_id, provider, category, display_name, validity,
                  cost_price, sell_price, is_active, updated_at`,
      params
    );

    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    res.json({
      success: true,
      message: 'Plan updated',
      data: { plan: shapePlan(rows[0]) },
    });
  } catch (err) {
    console.error('[adminPricing.updateDataPlan]', err);
    res.status(500).json({ success: false, message: 'Could not update plan' });
  }
}

/* ============================================================
   POST /admin/data-plans/bulk
   Body: { updates: [{ plan_id, sell_price }] }
   ============================================================ */
export async function bulkUpdatePrices(req, res) {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (!updates.length) {
      return res.status(400).json({ success: false, message: 'updates array is required' });
    }

    let updated = 0;
    const errors = [];

    for (const u of updates) {
      const planId = String(u.plan_id || '').trim();
      const sell   = Number(u.sell_price);

      if (!planId || isNaN(sell) || sell < 0) {
        errors.push({ plan_id: planId, reason: 'invalid' });
        continue;
      }

      try {
        const { rowCount } = await query(
          `UPDATE data_plans
              SET sell_price = $1, updated_at = NOW()
            WHERE plan_id = $2`,
          [Math.round(sell * 100) / 100, planId]
        );
        if (rowCount > 0) updated++;
        else errors.push({ plan_id: planId, reason: 'not found' });
      } catch (e) {
        errors.push({ plan_id: planId, reason: e.message });
      }
    }

    res.json({ success: true, data: { updated, errors } });
  } catch (err) {
    console.error('[adminPricing.bulkUpdatePrices]', err);
    res.status(500).json({ success: false, message: 'Bulk update failed' });
  }
}