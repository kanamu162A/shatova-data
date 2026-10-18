// services/data.service.js
// ============================================================
// Shatova — Data Service (v12 — admin sell prices + live cost guard)
//   ⭐ v10 behaviour preserved 100% for:
//        holdFunds / releaseHold / dropHold
//        datashop_submitted flag
//        2h "not found" refund policy
//        reconciler
//        audit
//   ⭐ v11 change: live catalogue (getNetworks/getCategories/getBundles)
//   ⭐ v12 change:
//        getBundles now merges admin sell_price (data_plans) with live cost
//        purchaseData guard: sell_price must be >= live cost, else 409
//        getPurchaseSummary (unchanged from v11)
// ============================================================

import { query } from '../config/database.js';
import * as datashop from './datashop.service.js';
import * as wallet    from './wallet.service.js';

const PROVIDER_ORDER = { mtn: 1, airtel: 2, glo: 3, t2: 4, '9mobile': 4 };
const CATEGORY_PRIORITY = [
  { match: 'share',       weight: 1 },
  { match: 'mobile data', weight: 2 },
  { match: 'social',      weight: 3 },
  { match: 'sme',         weight: 4 },
  { match: 'gifting',     weight: 5 },
  { match: 'always on',   weight: 6 },
  { match: 'fibre',       weight: 7 },
  { match: 'corporate',   weight: 8 },
];

/* ── Reconciliation scheduling ── */
const RECONCILE_FIRST_MS               = 20_000;
const RECONCILE_INTERVAL_MS            = 60_000;
const RECONCILE_MAX_ATTEMPTS           = 15;
const MIN_AGE_BEFORE_NOT_FOUND_REFUND  = 120;

/* Global markup fallback — used only when a plan has NO admin sell_price.
   Set to 0 to mean "sell at cost" (no loss, no margin). */
const GLOBAL_MARKUP_PCT = 0;

function normalizeNetwork(key = '') {
  const k = String(key).toLowerCase();
  if (k.includes('mtn'))    return 'mtn';
  if (k.includes('airtel')) return 'airtel';
  if (k.includes('glo'))    return 'glo';
  if (k.includes('t2') || k.includes('9mobile') || k.includes('etisalat')) return 't2';
  return k;
}
function providerWeight(key) { return PROVIDER_ORDER[normalizeNetwork(key)] ?? 99; }
function categoryWeight(name = '') {
  const n = String(name).toLowerCase().trim();
  for (const p of CATEGORY_PRIORITY) if (n.includes(p.match)) return p.weight;
  return 999;
}
function mapRow(row) {
  return {
    plan_id:      row.plan_id,
    product_name: row.plan_id,
    name:         row.display_name || row.plan_id,
    provider:     normalizeNetwork(row.provider),
    category:     row.category || 'MOBILE DATA',
    quantity:     '',
    validity:     row.validity || '',
    description:  row.description || '',
    price:        Number(row.sell_price ?? row.cost_price ?? 0),
    available:    row.is_active === true,
    require_validation: false,
  };
}

/* ⭐ Return the final user-facing price for a live product, using the admin
   override from data_plans if one exists. If no override exists, apply
   the global markup. Never returns less than the live cost (unless the
   admin deliberately set a lower sell_price — in which case callers that
   care about loss get a signal via `below_cost = true`). */
function computeSellPrice(livePrice, overrideSellPrice) {
  const live = Number(livePrice) || 0;
  if (overrideSellPrice != null && Number(overrideSellPrice) > 0) {
    const sell = Number(overrideSellPrice);
    return { price: sell, source: 'override', below_cost: sell < live };
  }
  const sell = Math.round(live * (1 + GLOBAL_MARKUP_PCT / 100) * 100) / 100;
  return { price: sell, source: 'markup', below_cost: sell < live };
}

/* ============================================================
   TRANSACTION HELPERS
   ============================================================ */
async function createTransaction({
  userId, reference, network, planId, productName, phone,
  amount, userPrice, costPrice, profit, paymentMethod, meta = {},
}) {
  const { rows } = await query(
    `INSERT INTO transactions
       (user_id, reference, type, service, direction, amount, status,
        description, metadata, network,
        cost_price, profit,
        created_at, updated_at)
     VALUES ($1, $2, 'DATA', 'data', 'DEBIT', $3, 'PENDING',
             $4, $5::jsonb, $6,
             $7, $8,
             NOW(), NOW())
     RETURNING *`,
    [
      userId, reference, userPrice,
      `${network.toUpperCase()} ${productName} → ${phone}`,
      JSON.stringify({
        network, plan_id: planId, product_name: productName, phone,
        base_price: amount, user_price: userPrice,
        payment_method: paymentMethod,
        datashop_submitted: false,
        ...meta,
      }),
      network.toUpperCase(),
      costPrice, profit,
    ]
  );
  return rows[0];
}

async function updateTransaction(reference, fields = {}) {
  const sets = [];
  const params = [];

  const push = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (fields.status)                     push('status', String(fields.status).toUpperCase());
  if (fields.description !== undefined)  push('description', fields.description);
  if (fields.remark !== undefined)       push('remark', fields.remark);
  if (fields.provider_reference)         push('provider_reference', fields.provider_reference);
  if (fields.cost_price !== undefined)   push('cost_price', Number(fields.cost_price) || 0);
  if (fields.profit !== undefined)       push('profit', Number(fields.profit) || 0);

  if (fields.metadata) {
    params.push(JSON.stringify(fields.metadata));
    sets.push(`metadata = metadata || $${params.length}::jsonb`);
  }

  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  params.push(reference);

  try {
    const { rows } = await query(
      `UPDATE transactions SET ${sets.join(', ')} WHERE reference = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) console.error(`[data] ❌ updateTransaction: no row for ${reference}`);
    else console.log(`[data] ✅ tx → ${rows[0].status} | ${reference}`);
    return rows[0] || null;
  } catch (err) {
    console.error(`[data] ❌❌ updateTransaction FAILED ${reference}:`, err.message);
    throw err;
  }
}

async function findTransactionByReference(reference) {
  const { rows } = await query(`SELECT * FROM transactions WHERE reference = $1 LIMIT 1`, [reference]);
  return rows[0] || null;
}

async function markDatashopSubmitted(reference) {
  try {
    await query(
      `UPDATE transactions
          SET metadata = metadata || $1::jsonb,
              updated_at = NOW()
        WHERE reference = $2`,
      [
        JSON.stringify({
          datashop_submitted: true,
          datashop_submitted_at: new Date().toISOString(),
        }),
        reference,
      ]
    );
  } catch (err) {
    console.error(`[data] ⚠ could not write datashop_submitted flag for ${reference}:`, err.message);
  }
}

/* ============================================================
   GET NETWORKS  (LIVE)
   ============================================================ */
export async function getNetworks() {
  const products = await datashop.getLiveProducts().catch(() => []);
  const counts = {};
  for (const p of products) {
    if (!p.available) continue;
    const k = normalizeNetwork(p.network);
    counts[k] = (counts[k] || 0) + 1;
  }
  const networks = Object.keys(counts).map((key) => ({
    key,
    name: key.toUpperCase(),
    products: counts[key],
  })).sort((a, b) => providerWeight(a.key) - providerWeight(b.key));

  if (!networks.length) {
    return [
      { key: 'mtn',    name: 'MTN',     products: 0 },
      { key: 'airtel', name: 'Airtel',  products: 0 },
      { key: 'glo',    name: 'Glo',     products: 0 },
      { key: 't2',     name: '9mobile', products: 0 },
    ];
  }
  return networks;
}

/* ============================================================
   GET CATEGORIES  (LIVE)
   ============================================================ */
export async function getCategories(networkKey = 'all') {
  const net = String(networkKey || 'all').toLowerCase();
  const products = await datashop.getLiveProducts().catch(() => []);
  const map = new Map();

  for (const p of products) {
    const pn = normalizeNetwork(p.network);
    if (net !== 'all' && pn !== net) continue;
    const cat = p.category || 'MOBILE DATA';
    const k = `${pn}||${cat}`;
    if (!map.has(k)) map.set(k, { provider: pn, category: cat, available: 0, total: 0 });
    const row = map.get(k);
    row.total += 1;
    if (p.available) row.available += 1;
  }

  const categories = [...map.values()].sort((a, b) => {
    const aAvail = a.available > 0 ? 0 : 1, bAvail = b.available > 0 ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    const aP = providerWeight(a.provider), bP = providerWeight(b.provider);
    if (aP !== bP) return aP - bP;
    const aC = categoryWeight(a.category), bC = categoryWeight(b.category);
    if (aC !== bC) return aC - bC;
    return String(a.category).localeCompare(String(b.category));
  });
  return categories;
}

/* ============================================================
   GET BUNDLES  (LIVE cost + admin sell_price merge)
   ------------------------------------------------------------
   Steps:
     1. Live products from DataShop  (what to show)
     2. Admin overrides from data_plans (what to charge)
     3. merge → final `price` per plan
   Any plan with a `sell_price` in data_plans uses it; otherwise
   `live_price × (1 + GLOBAL_MARKUP_PCT / 100)`.
   ============================================================ */
export async function getBundles({ network, category } = {}) {
  const net = String(network || '').toLowerCase();
  if (!net) throw new Error('network is required');

  const products = await datashop.getLiveProducts().catch(() => []);
  const cat = category ? String(category).toUpperCase() : null;

  /* Pull admin overrides once */
  let overrideMap = new Map();
  try {
    const { rows } = await query(
      `SELECT plan_id, sell_price, is_active
         FROM data_plans
        WHERE plan_id IS NOT NULL`
    );
    overrideMap = new Map(rows.map((r) => [String(r.plan_id).toLowerCase(), r]));
  } catch (_) { /* data_plans missing — use markup only */ }

  const rows = products
    .filter((p) => normalizeNetwork(p.network) === net)
    .filter((p) => (cat ? String(p.category).toUpperCase() === cat : true))
    .map((p) => {
      const livePrice = Number(p.price) || 0;
      const override  = overrideMap.get(String(p.product_name).toLowerCase());
      const overrideSell = override && override.sell_price != null
        ? Number(override.sell_price)
        : null;
      const { price, below_cost } = computeSellPrice(livePrice, overrideSell);

      return {
        plan_id:      p.product_name,
        product_name: p.product_name,
        name:         p.name,
        provider:     normalizeNetwork(p.network),
        category:     p.category || 'MOBILE DATA',
        quantity:     '',
        validity:     p.validity || '',
        description:  p.description || '',
        price,                       // ⭐ admin sell price (or markup)
        cost_price:   livePrice,     // live DataShop cost
        available:    p.available === true && (override ? override.is_active !== false : true),
        below_cost,                  // true if admin accidentally priced below cost
        require_validation: false,
      };
    })
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.price - b.price;
    });

  return rows;
}

/* ============================================================
   VERIFY CUSTOMER
   ============================================================ */
export async function verifyCustomer({ phone, productName }) {
  if (!phone || !productName) throw new Error('phone and productName are required');
  const result = await datashop.verifyCustomer({ customer_id: phone, product_name: productName });
  return {
    verified: result.verified !== false,
    customer_id: result.customer_id || phone,
    customer_name: result.customer_name || null,
    provider: result.provider || null,
  };
}

/* ============================================================
   PURCHASE — hold / submit-flag / release / drop
   ------------------------------------------------------------
   v12 guard: the admin sell_price MUST be >= live cost.
   If DataShop raised the cost above the admin sell_price,
   the purchase is blocked with PRICE_CHANGED (409) so the
   user is never sold at a loss.
   ------------------------------------------------------------
   Everything below the guard (create tx → hold → mark submitted
   → buy → interpret → release/drop → persist) is unchanged
   from v10.
   ============================================================ */
export async function purchaseData({
  userId, planId, phone, mode = 'single', paymentMethod = 'wallet',
}) {
  if (!userId) throw new Error('User ID is required');
  if (!planId) throw new Error('planId is required');
  if (!phone)  throw new Error('phone is required');

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!/^0\d{10}$/.test(cleanPhone)) throw new Error('Invalid Nigerian phone number');

  /* ⭐ LIVE COST + ADMIN SELL PRICE */
  const live = await datashop.getLiveProduct(planId).catch(() => null);
  if (!live) {
    const e = new Error('This product is no longer available. Please refresh.');
    e.code = 'PLAN_UNAVAILABLE';
    throw e;
  }
  if (live.available !== true) {
    const e = new Error('This plan is currently unavailable. Please choose another.');
    e.code = 'PLAN_UNAVAILABLE';
    throw e;
  }
  const liveCost = Number(live.price) || 0;
  if (!liveCost || liveCost <= 0) {
    const e = new Error('Invalid product price');
    e.code = 'INVALID_PLAN';
    throw e;
  }

  /* Admin override (may be null if not priced) */
  const { rows: planRows } = await query(
    `SELECT plan_id, provider, display_name, sell_price, is_active
       FROM data_plans WHERE plan_id = $1 LIMIT 1`,
    [planId]
  );
  const plan = planRows[0] || {
    plan_id: planId,
    provider: live.network,
    display_name: live.name,
    sell_price: null,
    is_active: true,
  };

  if (plan.is_active === false) {
    const e = new Error('This plan is currently unavailable. Please choose another.');
    e.code = 'PLAN_UNAVAILABLE';
    throw e;
  }

  const overrideSell = plan.sell_price != null && Number(plan.sell_price) > 0
    ? Number(plan.sell_price)
    : null;

  const { price: userPrice, source: priceSource, below_cost } =
    computeSellPrice(liveCost, overrideSell);

  /* ⭐ LOSS GUARD — block if we'd sell below provider cost */
  if (below_cost) {
    console.warn(
      `[data] 🚫 ${planId} blocked — sell ₦${userPrice} < cost ₦${liveCost} (source=${priceSource})`
    );
    const e = new Error(
      'This plan’s price is being updated. Please refresh and try another bundle.'
    );
    e.code = 'PRICE_CHANGED';
    e.data = {
      plan_id:     planId,
      live_cost:   liveCost,
      sell_price:  userPrice,
      source:      priceSource,
    };
    throw e;
  }

  const rawPrice  = liveCost;
  const costPrice = liveCost;
  let   profit    = Math.round((userPrice - costPrice) * 100) / 100;

  const reference = datashop.generateReference('shatova-data');

  console.log(`[data] ═══ START ${reference} ═══`);
  console.log(`[data]   plan=${planId} phone=${cleanPhone} live_cost=₦${liveCost} user_price=₦${userPrice} (${priceSource})`);

  const txRecord = await createTransaction({
    userId, reference,
    network: normalizeNetwork(plan.provider || live.network),
    planId,
    productName: plan.display_name || live.name || planId,
    phone: cleanPhone,
    amount: rawPrice,
    userPrice, costPrice, profit,
    paymentMethod,
    meta: {
      mode,
      live_price_verified_at: new Date().toISOString(),
      price_source: priceSource,
      live_cost: liveCost,
    },
  }).catch((err) => {
    console.error('[data] ❌ tx create failed:', err.message);
    throw new Error('Could not create transaction record');
  });

  console.log(`[data] ✅ tx created (id=${txRecord.id})`);

  let finalStatus  = 'failed';
  let remark       = 'Unknown error';
  let dsResult     = null;
  let held         = false;
  let walletBefore = null;
  let walletAfter  = null;
  let caughtErr    = null;
  let dsCost       = costPrice;
  let dsProfit     = profit;
  let ambiguous    = false;
  let submitted    = false;

  try {
    /* ⭐ STEP 1: Hold funds */
    if (paymentMethod === 'wallet') {
      try {
        const w = await wallet.getWallet(userId);
        walletBefore = Number(w?.balance || 0);

        const holdResult = await wallet.holdFunds({
          userId,
          amount: userPrice,
          reference,
          description: `Data purchase — ${plan.display_name || planId}`,
        });

        held = true;
        walletAfter = Number(holdResult?.balance_after ?? (walletBefore - userPrice));
        console.log(`[data] 🔒 hold placed ₦${userPrice} | ${walletBefore} → ${walletAfter}`);
      } catch (err) {
        console.error('[data] ❌ holdFunds failed:', err.message);
        finalStatus = 'failed';
        remark      = err.message || 'Insufficient balance';
        const e = new Error(remark);
        e.code = err.code || 'INSUFFICIENT_BALANCE';
        e.data = err.data || { balance: walletBefore, required: userPrice };
        throw e;
      }
    }

    /* ⭐ STEP 2a: WRITE THE FLAG — before calling Datashop */
    await markDatashopSubmitted(reference);
    submitted = true;
    console.log(`[data] 📝 marked datashop_submitted=true for ${reference}`);

    /* ⭐ STEP 2b: Call DataShop */
    dsResult = await datashop.buyData({
      customer_id: cleanPhone,
      product_name: plan.plan_id,
      reference,
    });

    console.log(`[data] 📡 datashop result:`);
    console.log(`[data]   ok=${dsResult.ok} status=${dsResult.status} mayHaveSucceeded=${dsResult.mayHaveSucceeded} isTimeout=${dsResult.isTimeout}`);

    /* ⭐ STEP 3: Interpret */
    if (dsResult.ok && !dsResult.mayHaveSucceeded) {
      const normalized = datashop.normalizeProviderStatus(dsResult.data);
      finalStatus = normalized === 'successful' ? 'success'
                  : normalized === 'failed'     ? 'failed'
                  : 'processing';
      const payload = dsResult.data?.data || {};
      remark = payload.remark || dsResult.data?.message || 'Submitted';

    } else if (dsResult.ok && dsResult.mayHaveSucceeded) {
      const normalized = datashop.normalizeProviderStatus(dsResult.data);
      if (normalized === 'successful')   finalStatus = 'success';
      else if (normalized === 'failed')  finalStatus = 'failed';
      else                                finalStatus = 'processing';

      const payload = dsResult.data?.data || {};
      remark = payload.remark || dsResult.data?.message
            || (finalStatus === 'success' ? 'Purchase successful' : 'Confirming with provider…');

      if (payload.paid_amount) {
        dsCost   = Number(payload.paid_amount) || costPrice;
        dsProfit = Math.round((userPrice - dsCost) * 100) / 100;
      }

    } else if (!dsResult.ok && dsResult.mayHaveSucceeded) {
      finalStatus = 'processing';
      ambiguous   = true;
      remark = dsResult.error
            || 'Taking longer than usual. We are confirming with the provider.';
      console.warn(`[data] ⚠ AMBIGUOUS — treating as processing: ${remark}`);

    } else {
      finalStatus = 'failed';
      remark      = dsResult.error || 'Purchase could not be completed';
      console.warn(`[data] ❌ definite failure: ${remark}`);
    }

    console.log(`[data] ✅ interpreted → ${finalStatus} | ambiguous=${ambiguous} | cost=₦${dsCost} profit=₦${dsProfit}`);
    console.log(`[data]   remark="${remark}"`);

  } catch (err) {
    caughtErr = caughtErr || err;
  }

  /* ⭐ STEP 4: Release or drop the hold. */
  if (held) {
    if (finalStatus === 'success') {
      try {
        await wallet.releaseHold({
          userId,
          reference,
          transactionId: txRecord.id,
          description: `Data purchase — ${plan.display_name || planId}`,
        });
        console.log(`[data] 🔓 hold released for ${reference}`);
      } catch (err) {
        console.error('[data] ❌ releaseHold failed:', err.message);
      }
    } else if (finalStatus === 'failed') {
      try {
        await wallet.dropHold({ userId, reference });
        console.log(`[data] 🔙 hold dropped for ${reference} (money returned)`);
      } catch (err) {
        console.error('[data] ❌ dropHold failed:', err.message);
      }
    } else {
      console.log(`[data] ⏸ hold kept HELD for ${reference} — reconciler will decide`);
    }
  }

  /* ⭐ STEP 5: Persist final state */
  const payload = dsResult?.data?.data || {};
  const metadata = {
    ds_reference:      payload.reference || reference,
    ds_status:         payload.transaction_status || '',
    ds_quantity:       payload.quantity || '',
    ds_provider:       payload.provider || plan.provider || '',
    ds_paid_amount:    Number(payload.paid_amount || 0),
    ds_balance_before: Number(payload.balance_before ?? 0),
    ds_balance_after:  Number(payload.balance_after  ?? 0),
    wallet_before:     walletBefore,
    wallet_after:      walletAfter,
    processor:         payload.processor || '',
    ambiguous:         ambiguous,
    datashop_submitted: submitted,
    reconcile_attempts: 0,
    reconcile_next_at:  finalStatus === 'processing'
      ? new Date(Date.now() + RECONCILE_FIRST_MS).toISOString()
      : null,
  };

  try {
    await updateTransaction(reference, {
      status: finalStatus.toUpperCase(),
      description: remark,
      remark,
      provider_reference: payload.reference || reference,
      cost_price: dsCost,
      profit:     dsProfit,
      metadata,
    });
  } catch (err) {
    console.error(`[data] ❌❌❌ could not save final state:`, err.message);
  }

  console.log(`[data] ═══ DONE ${reference} → ${finalStatus.toUpperCase()} ═══`);

  if (caughtErr) {
    const e = new Error(caughtErr.message || 'Purchase failed');
    e.code = caughtErr.code || 'PURCHASE_FAILED';
    e.data = { reference };
    throw e;
  }

  return {
    reference,
    status: finalStatus,
    ambiguous,
    product: plan.display_name || planId,
    amount: userPrice,
    original_amount: rawPrice,
    cost_price: dsCost,
    profit: dsProfit,
    network: normalizeNetwork(plan.provider || live.network),
    phone: cleanPhone,
    remark,
    quantity: payload.quantity || '',
    provider: payload.provider || plan.provider || '',
    wallet_before: walletBefore,
    wallet_after:  walletAfter,
    ds_balance_before: metadata.ds_balance_before,
    ds_balance_after:  metadata.ds_balance_after,
  };
}

/* ============================================================
   GET STATUS
   ============================================================ */
export async function getStatus(reference) {
  if (!reference) throw new Error('reference is required');

  const txRecord = await findTransactionByReference(reference);
  if (!txRecord) throw new Error('Transaction not found');

  const currentStatus = String(txRecord.status || '').toLowerCase();
  const meta = txRecord.metadata || {};

  if (['success', 'failed'].includes(currentStatus)) {
    return {
      reference: txRecord.reference,
      status:    currentStatus,
      remark:    txRecord.remark || txRecord.description || '',
      amount:    Number(txRecord.amount) || 0,
      recipient: meta.phone || '',
      product:   meta.product_name || '',
      wallet_before: meta.wallet_before ?? null,
      wallet_after:  meta.wallet_after  ?? null,
    };
  }

  if (meta.datashop_submitted === false) {
    return {
      reference,
      status: currentStatus || 'pending',
      remark: txRecord.remark || txRecord.description || 'Preparing to submit…',
      amount: Number(txRecord.amount) || 0,
      recipient: meta.phone || '',
      product:   meta.product_name || '',
      wallet_before: meta.wallet_before ?? null,
      wallet_after:  meta.wallet_after  ?? null,
    };
  }

  let ds;
  try {
    ds = await datashop.checkTransactionStatus(reference);
  } catch {
    return {
      reference,
      status: currentStatus || 'processing',
      remark: txRecord.remark || txRecord.description || 'Still processing',
      amount: Number(txRecord.amount) || 0,
      recipient: meta.phone || '',
      product:   meta.product_name || '',
      wallet_before: meta.wallet_before ?? null,
      wallet_after:  meta.wallet_after  ?? null,
    };
  }

  const normalized = datashop.normalizeProviderStatus(ds);
  let newStatus = currentStatus;
  if (normalized === 'successful')      newStatus = 'success';
  else if (normalized === 'failed')     newStatus = 'failed';
  else                                  newStatus = 'processing';

  const dsPayload = ds?.data || ds || {};
  const dsRemark = dsPayload.remark || ds?.message || txRecord.remark || txRecord.description;
  const amount = Number(meta.user_price || txRecord.amount);
  const dsCost = Number(dsPayload.paid_amount || txRecord.cost_price || 0);
  const dsProfit = Math.round((amount - dsCost) * 100) / 100;

  if (newStatus !== currentStatus && (newStatus === 'success' || newStatus === 'failed')) {
    try {
      if (newStatus === 'success') {
        await wallet.releaseHold({
          userId: txRecord.user_id,
          reference,
          transactionId: txRecord.id,
          description: `Data purchase — ${meta.product_name || ''}`,
        });
        console.log(`[data.getStatus] 🔓 released ${reference}`);
      } else {
        await wallet.dropHold({ userId: txRecord.user_id, reference });
        console.log(`[data.getStatus] 🔙 dropped ${reference}`);
      }
    } catch (err) {
      console.warn('[data.getStatus] wallet op:', err.message);
    }

    await updateTransaction(reference, {
      status: newStatus.toUpperCase(),
      description: dsRemark,
      remark: dsRemark,
      provider_reference: dsPayload.reference || meta.ds_reference || reference,
      cost_price: dsCost,
      profit: dsProfit,
      metadata: {
        ds_status: dsPayload.transaction_status || '',
        ds_quantity: dsPayload.quantity || meta.ds_quantity || '',
      },
    });
  }

  return {
    reference,
    status: newStatus,
    remark: dsRemark,
    amount: Number(txRecord.amount) || 0,
    recipient: meta.phone || '',
    product: meta.product_name || '',
    wallet_before: meta.wallet_before ?? null,
    wallet_after:  meta.wallet_after  ?? null,
  };
}

/* ============================================================
   RECONCILER — run from cron every 60s
   ============================================================ */
export async function reconcileProcessingDataTransactions(limit = 50) {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, cost_price, status, metadata, remark, description, created_at
       FROM transactions
      WHERE type = 'DATA'
        AND status IN ('PROCESSING', 'PENDING')
        AND service = 'data'
        AND (
          (metadata->>'reconcile_next_at') IS NULL
          OR (metadata->>'reconcile_next_at')::timestamptz <= NOW()
        )
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  if (!rows.length) return { checked: 0, finalized: 0, stillPending: 0, refunded: 0 };

  console.log(`[reconcile] found ${rows.length} pending/processing DATA tx`);

  let finalized    = 0;
  let stillPending = 0;
  let refunded     = 0;

  for (const tx of rows) {
    const ref = tx.reference;
    const meta = tx.metadata || {};
    const attempts = Number(meta.reconcile_attempts || 0);
    const createdAtMs = new Date(tx.created_at).getTime();
    const ageMs = Date.now() - createdAtMs;
    const ageMinutes = Math.floor(ageMs / 60000);

    const submitted = meta.datashop_submitted;
    if ((submitted === false || submitted === undefined) && ageMs > 30_000) {
      console.warn(`[reconcile] 🚫 ${ref} — never submitted to Datashop (${Math.floor(ageMs / 1000)}s old) → refund`);

      await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch((e) => {
        console.warn(`[reconcile] dropHold failed for ${ref}:`, e.message);
      });

      await updateTransaction(ref, {
        status: 'FAILED',
        description: 'Purchase never reached provider — refunded',
        remark: 'Purchase never reached provider — refunded',
        metadata: {
          reconcile_result: 'never_submitted',
          reconcile_attempts: attempts + 1,
          reconcile_next_at: null,
          reconciled_at: new Date().toISOString(),
        },
      }).catch(() => {});

      refunded++;
      continue;
    }

    try {
      const ds = await datashop.checkTransactionStatus(ref);
      const normalized = datashop.normalizeProviderStatus(ds);
      const payload = ds?.data || ds || {};
      const dsRemark = payload.remark || ds?.message || '';

      if (normalized === 'successful') {
        await wallet.releaseHold({
          userId: tx.user_id,
          reference: ref,
          transactionId: tx.id,
          description: `Data purchase — ${meta.product_name || ''}`,
        }).catch(() => {});

        await updateTransaction(ref, {
          status: 'SUCCESS',
          description: dsRemark || 'Purchase successful',
          remark: dsRemark || 'Purchase successful',
          provider_reference: payload.reference || meta.ds_reference || ref,
          cost_price: Number(payload.paid_amount || tx.cost_price || 0),
          metadata: {
            ds_status: payload.transaction_status || '',
            reconcile_attempts: attempts + 1,
            reconcile_next_at: null,
            reconciled_at: new Date().toISOString(),
          },
        });
        finalized++;
        console.log(`[reconcile] ✅ ${ref} → SUCCESS`);

      } else if (normalized === 'failed') {
        await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});

        await updateTransaction(ref, {
          status: 'FAILED',
          description: dsRemark || 'Purchase failed',
          remark: dsRemark || 'Purchase failed',
          metadata: {
            ds_status: payload.transaction_status || '',
            reconcile_attempts: attempts + 1,
            reconcile_next_at: null,
            reconciled_at: new Date().toISOString(),
          },
        });
        finalized++;
        console.log(`[reconcile] ❌ ${ref} → FAILED (hold dropped)`);

      } else {
        const nextAt = new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString();

        if (attempts + 1 >= RECONCILE_MAX_ATTEMPTS) {
          console.warn(`[reconcile] ⚠ ${ref} exceeded ${RECONCILE_MAX_ATTEMPTS} attempts — giving up and refunding`);
          await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});

          await updateTransaction(ref, {
            status: 'FAILED',
            description: 'Could not confirm with provider. Amount reversed.',
            remark: 'Could not confirm with provider. Amount reversed.',
            metadata: {
              reconcile_attempts: attempts + 1,
              reconcile_next_at: null,
              reconciled_at: new Date().toISOString(),
              reconciled_reason: 'max_attempts_exceeded',
            },
          });
          finalized++;
        } else {
          await updateTransaction(ref, {
            metadata: {
              reconcile_attempts: attempts + 1,
              reconcile_next_at: nextAt,
              last_checked_at: new Date().toISOString(),
            },
          });
          stillPending++;
        }
      }

    } catch (err) {
      const isNotFound =
        err.code === 'NOT_FOUND' ||
        err.code === 'LEGACY_REFERENCE' ||
        /not found on DataShop/i.test(err.message || '');

      if (isNotFound) {
        const newAttempts   = attempts + 1;
        const notFoundCount = Number(meta.not_found_count || 0) + 1;

        if (notFoundCount >= RECONCILE_MAX_ATTEMPTS && ageMinutes >= MIN_AGE_BEFORE_NOT_FOUND_REFUND) {
          console.warn(`[reconcile] 🔙 ${ref} — not found ${notFoundCount}× and ${ageMinutes}min old → refund`);

          await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});

          await updateTransaction(ref, {
            status: 'FAILED',
            description: 'Not received by provider after 2h — auto-refunded',
            remark: 'Not received by provider after 2h — auto-refunded',
            metadata: {
              reconcile_attempts: newAttempts,
              not_found_count: notFoundCount,
              reconcile_result: 'not_found_after_2h',
              reconcile_next_at: null,
              reconciled_at: new Date().toISOString(),
            },
          });
          finalized++;
        } else {
          const nextAt = new Date(Date.now() + RECONCILE_INTERVAL_MS * 5).toISOString();

          await updateTransaction(ref, {
            metadata: {
              reconcile_attempts: newAttempts,
              not_found_count: notFoundCount,
              reconcile_next_at: nextAt,
              last_not_found_at: new Date().toISOString(),
              waiting_reason: 'datashop_index_delay',
            },
          }).catch(() => {});
          stillPending++;
          console.log(
            `[reconcile] 🔎 ${ref} — not found (${notFoundCount}, age=${ageMinutes}min) — still waiting`
          );
        }
      } else {
        console.warn(`[reconcile] ⚠ ${ref} error: ${err.message}`);
        const nextAt = new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString();

        await updateTransaction(ref, {
          metadata: {
            reconcile_attempts: attempts + 1,
            reconcile_next_at: nextAt,
            last_error: String(err.message || '').slice(0, 200),
          },
        }).catch(() => {});
        stillPending++;
      }
    }
  }

  console.log(`[reconcile] done — finalized=${finalized} refunded=${refunded} stillPending=${stillPending}`);
  return { checked: rows.length, finalized, refunded, stillPending };
}

/* ============================================================
   AUDIT — run hourly
   ============================================================ */
export async function auditFailedTransactions(hoursBack = 24) {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, status, cost_price, created_at, metadata
       FROM transactions
      WHERE type = 'DATA'
        AND service = 'data'
        AND status IN ('FAILED', 'SUCCESS')
        AND (audit_reviewed IS NULL OR audit_reviewed = FALSE)
        AND created_at > NOW() - INTERVAL '${Number(hoursBack)} hours'
      ORDER BY created_at DESC
      LIMIT 200`
  );

  if (!rows.length) return { checked: 0, mismatches: 0 };

  let mismatches = 0;
  let checked = 0;

  for (const tx of rows) {
    checked++;
    try {
      const ds = await datashop.checkTransactionStatus(tx.reference);
      const normalized = datashop.normalizeProviderStatus(ds);

      const ourStatus =
        String(tx.status).toLowerCase() === 'success' ? 'successful' :
        String(tx.status).toLowerCase() === 'failed'  ? 'failed' :
        'processing';

      const dsStatus =
        normalized === 'successful' ? 'successful' :
        normalized === 'failed'     ? 'failed' :
        'processing';

      if (dsStatus === 'processing') continue;
      if (dsStatus === ourStatus) continue;

      mismatches++;

      if (ourStatus === 'failed' && dsStatus === 'successful') {
        console.error(
          `[audit] 🚨 ${tx.reference}: DB=FAILED but DataShop=SUCCESS — ` +
          `user was refunded but got the product. user=${tx.user_id} amount=₦${tx.amount}`
        );

        await query(
          `INSERT INTO audit_mismatches
             (reference, user_id, amount, our_status, ds_status, created_at, severity)
           VALUES ($1, $2, $3, $4, $5, NOW(), 'CRITICAL')
           ON CONFLICT (reference) DO NOTHING`,
          [tx.reference, tx.user_id, tx.amount, ourStatus, dsStatus]
        ).catch(() => {});
      }

      if (ourStatus === 'successful' && dsStatus === 'failed') {
        console.error(
          `[audit] ⚠ ${tx.reference}: DB=SUCCESS but DataShop=FAILED — ` +
          `user charged but didn't get product. user=${tx.user_id} amount=₦${tx.amount}`
        );

        await query(
          `INSERT INTO audit_mismatches
             (reference, user_id, amount, our_status, ds_status, created_at, severity)
           VALUES ($1, $2, $3, $4, $5, NOW(), 'HIGH')
           ON CONFLICT (reference) DO NOTHING`,
          [tx.reference, tx.user_id, tx.amount, ourStatus, dsStatus]
        ).catch(() => {});
      }

    } catch (err) {
      /* Datashop unreachable — skip */
    }
  }

  console.log(`[audit] checked=${checked} mismatches=${mismatches}`);
  return { checked, mismatches };
}

/* ============================================================
   PURCHASE SUMMARY  (today / yesterday, Nigeria time)
   ============================================================ */
export async function getPurchaseSummary(userId) {
  if (!userId) throw new Error('userId is required');

  const { rows } = await query(
    `WITH bounds AS (
       SELECT
         (NOW() AT TIME ZONE 'Africa/Lagos')::date                             AS today,
         ((NOW() AT TIME ZONE 'Africa/Lagos')::date - INTERVAL '1 day')::date  AS yesterday
     )
     SELECT
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.today)::int AS today_count,
       COALESCE(SUM(amount) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.today), 0)::numeric AS today_total,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.today AND status = 'SUCCESS')::int AS today_success,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.today AND status = 'FAILED')::int AS today_failed,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.today AND status IN ('PENDING','PROCESSING'))::int AS today_processing,

       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.yesterday)::int AS yesterday_count,
       COALESCE(SUM(amount) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.yesterday), 0)::numeric AS yesterday_total,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.yesterday AND status = 'SUCCESS')::int AS yesterday_success,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.yesterday AND status = 'FAILED')::int AS yesterday_failed,
       COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = bounds.yesterday AND status IN ('PENDING','PROCESSING'))::int AS yesterday_processing
     FROM transactions, bounds
     WHERE user_id = $1
       AND type    = 'DATA'
       AND service = 'data'`,
    [userId]
  );

  const r = rows[0] || {};
  const n = (v) => Number(v) || 0;
  return {
    today: {
      count:      n(r.today_count),
      total:      n(r.today_total),
      success:    n(r.today_success),
      failed:     n(r.today_failed),
      processing: n(r.today_processing),
    },
    yesterday: {
      count:      n(r.yesterday_count),
      total:      n(r.yesterday_total),
      success:    n(r.yesterday_success),
      failed:     n(r.yesterday_failed),
      processing: n(r.yesterday_processing),
    },
  };
}

export default {
  getNetworks,
  getCategories,
  getBundles,
  verifyCustomer,
  purchase,
  getStatus,
  getPurchaseSummary,
  reconcileProcessingDataTransactions,
  auditFailedTransactions,
};
