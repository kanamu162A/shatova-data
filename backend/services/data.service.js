// services/data.service.js
// ============================================================
// Shatova — Data Service (v10 — orphan-safe + 2h refund policy)
//   ⭐ Uses holdFunds / releaseHold / dropHold
//   ⭐ NEVER submits to Datashop without first writing
//     `datashop_submitted: true` to metadata
//   ⭐ Refuses to refund on "not found" until 2 HOURS have passed
//     (Datashop's lookup API is eventually consistent)
//   ⭐ Never refunds on timeout / network error
//   ⭐ Marks ambiguous transactions as PROCESSING
//   ⭐ User pays raw plan price (no discount)
//   ⭐ auditFailedTransactions skips audit_reviewed rows
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
const RECONCILE_FIRST_MS               = 20_000;    // first check 20s after purchase
const RECONCILE_INTERVAL_MS            = 60_000;    // then every 60s
const RECONCILE_MAX_ATTEMPTS           = 15;        // ~15 minutes of retries
const MIN_AGE_BEFORE_NOT_FOUND_REFUND  = 120;       // 2 hours — do NOT refund "not found" before this

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

/* ⭐ Mark intent-to-submit BEFORE the Datashop call.
   If the process dies during the network call, the reconciler
   sees `datashop_submitted: true` and knows to retry. If it dies
   BEFORE this flag is written, the reconciler sees `false` and
   refunds immediately. */
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
   GET NETWORKS
   ============================================================ */
export async function getNetworks() {
  const { rows } = await query(
    `SELECT provider, COUNT(*) FILTER (WHERE is_active = true)::int AS active_count
       FROM data_plans GROUP BY provider ORDER BY provider`
  );
  const networks = rows.map((r) => ({
    key: normalizeNetwork(r.provider),
    name: r.provider,
    products: r.active_count || 0,
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
   GET CATEGORIES
   ============================================================ */
export async function getCategories(networkKey = 'all') {
  const net = String(networkKey || 'all').toLowerCase();
  const params = [];
  let where = 'WHERE 1=1';
  if (net !== 'all') {
    params.push(net.toUpperCase());
    where += ` AND UPPER(provider) = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT provider, category,
            COUNT(*) FILTER (WHERE is_active = true)::int AS available,
            COUNT(*)::int                                  AS total
       FROM data_plans ${where}
      GROUP BY provider, category`,
    params
  );
  const categories = rows.map((r) => ({
    provider: normalizeNetwork(r.provider),
    category: r.category,
    available: r.available,
    total: r.total,
  }));
  categories.sort((a, b) => {
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
   GET BUNDLES
   ============================================================ */
export async function getBundles({ network, category } = {}) {
  const net = String(network || '').toLowerCase();
  if (!net) throw new Error('network is required');
  const params = [net.toUpperCase()];
  let where = 'WHERE UPPER(provider) = $1';
  if (category) {
    params.push(String(category).toUpperCase());
    where += ` AND UPPER(category) = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT plan_id, provider, category, display_name, validity, description,
            cost_price, sell_price, is_active
       FROM data_plans ${where}
      ORDER BY is_active DESC, category, cost_price ASC`,
    params
  );
  return rows.map(mapRow);
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
   ============================================================ */
export async function purchaseData({
  userId, planId, phone, mode = 'single', paymentMethod = 'wallet',
}) {
  if (!userId) throw new Error('User ID is required');
  if (!planId) throw new Error('planId is required');
  if (!phone)  throw new Error('phone is required');

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!/^0\d{10}$/.test(cleanPhone)) throw new Error('Invalid Nigerian phone number');

  const { rows: planRows } = await query(
    `SELECT plan_id, provider, display_name, cost_price, sell_price, is_active
       FROM data_plans WHERE plan_id = $1 LIMIT 1`,
    [planId]
  );
  const plan = planRows[0];
  if (!plan) throw new Error('Product not found');
  if (plan.is_active !== true) throw new Error('This plan is currently unavailable');

  const rawPrice  = Number(plan.sell_price ?? plan.cost_price ?? 0);
  const costPrice = Number(plan.cost_price ?? rawPrice);
  if (!rawPrice || rawPrice <= 0) throw new Error('Invalid product price');

  const userPrice = rawPrice;
  let   profit    = Math.round((userPrice - costPrice) * 100) / 100;

  const reference = datashop.generateReference('shatova-data');

  console.log(`[data] ═══ START ${reference} ═══`);
  console.log(`[data]   plan=${planId} phone=${cleanPhone} user=₦${userPrice} cost=₦${costPrice}`);

  const txRecord = await createTransaction({
    userId, reference,
    network: normalizeNetwork(plan.provider),
    planId,
    productName: plan.display_name || planId,
    phone: cleanPhone,
    amount: rawPrice,
    userPrice, costPrice, profit,
    paymentMethod,
    meta: { mode },
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

  /* ⭐ STEP 4: Release or drop the hold.
     • success    → release (money spent)
     • failed     → drop    (money returned)
     • processing → LEAVE HELD — let the reconciler decide */
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
    network: normalizeNetwork(plan.provider),
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
   ⭐ Handles PENDING and PROCESSING
   ⭐ Refunds immediately if datashop_submitted is false/undefined
   ⭐ Refuses to refund on "not found" until 2 HOURS have passed
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

    /* ── CASE 1: Never submitted to Datashop ──
       Grace period of 30s in case the flag write is still in flight. */
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

    /* ── CASE 2: Submitted to Datashop — check the real status ── */
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
        /* Still processing at Datashop — retry until max attempts */
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
        /* ⭐ NEW POLICY: Datashop's lookup API is eventually consistent.
           A "not found" does NOT mean the purchase failed. Wait 2 hours
           before refunding, giving Datashop's index time to catch up. */
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
          /* Back off — wait 5 minutes before next try */
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
   ⭐ Skips transactions marked audit_reviewed = TRUE
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