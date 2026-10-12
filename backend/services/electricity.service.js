// services/electricity.service.js
// ============================================================
// SHATOVA — Electricity Service
//   ⭐ Mirrors services/data.service.js (same architecture)
//   ⭐ Uses holdFunds / releaseHold / dropHold from wallet.service
//   ⭐ Writes to: transactions, bill_payments, money_audit_log
//   ⭐ NEVER submits to DataShop without writing
//       metadata.datashop_submitted = true first
//   ⭐ Refuses to auto-refund on "not found" until 2 hours pass
//   ⭐ 1% margin model (Option C):
//       user pays `amount`, DataShop charges `cost_price`,
//       profit = amount - cost_price
// ============================================================

import { query, withTransaction } from '../config/database.js';
import * as datashop from './datashop-electricity.service.js';
import * as wallet   from './wallet.service.js';

/* ── Business constants ── */
const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 200000;

const RECONCILE_FIRST_MS              = 20_000;
const RECONCILE_INTERVAL_MS           = 60_000;
const RECONCILE_MAX_ATTEMPTS          = 15;
const MIN_AGE_BEFORE_NOT_FOUND_REFUND = 120; // minutes

/* ============================================================
   HELPERS
   ============================================================ */
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function normalizeMeter(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function writeProviderAudit(eventType, data = {}) {
  try {
    await query(
      `INSERT INTO money_audit_log
         (event_type, user_id, wallet_id, reference, amount,
          balance_before, balance_after, actor, source, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        eventType,
        data.userId        ?? null,
        data.walletId      ?? null,
        data.reference     ?? null,
        data.amount        != null ? money(data.amount)        : null,
        data.balanceBefore != null ? money(data.balanceBefore) : null,
        data.balanceAfter  != null ? money(data.balanceAfter)  : null,
        data.actor  || 'system',
        data.source || 'electricity.service',
        JSON.stringify(data.details || {}),
      ]
    );
  } catch (err) {
    console.error('[electricity] audit write failed:', eventType, err.message);
  }
}

async function findTransactionByReference(reference) {
  const { rows } = await query(
    `SELECT * FROM transactions WHERE reference = $1 LIMIT 1`,
    [reference]
  );
  return rows[0] || null;
}

async function findBillPaymentByReference(reference) {
  const { rows } = await query(
    `SELECT bp.*, t.reference AS txn_reference
       FROM bill_payments bp
       JOIN transactions t ON t.id = bp.transaction_id
      WHERE t.reference = $1
      LIMIT 1`,
    [reference]
  );
  return rows[0] || null;
}

async function updateTransaction(reference, fields = {}) {
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (fields.status)                    push('status', String(fields.status).toUpperCase());
  if (fields.description !== undefined) push('description', fields.description);
  if (fields.remark !== undefined)      push('remark', fields.remark);
  if (fields.provider_reference)        push('provider_reference', fields.provider_reference);
  if (fields.provider_ref)              push('provider_ref', fields.provider_ref);
  if (fields.provider_status)           push('provider_status', fields.provider_status);
  if (fields.cost_price !== undefined)  push('cost_price', money(fields.cost_price));
  if (fields.profit !== undefined)      push('profit', money(fields.profit));
  if (fields.final_amount !== undefined) push('final_amount', money(fields.final_amount));
  if (fields.discount !== undefined)    push('discount', money(fields.discount));

  if (fields.metadata) {
    params.push(JSON.stringify(fields.metadata));
    sets.push(`metadata = metadata || $${params.length}::jsonb`);
  }

  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  params.push(reference);

  const { rows } = await query(
    `UPDATE transactions SET ${sets.join(', ')} WHERE reference = $${params.length} RETURNING *`,
    params
  );
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
    console.error(`[electricity] ⚠ could not write datashop_submitted for ${reference}:`, err.message);
  }
}

/* ============================================================
   PRODUCTS — read from electricity_bills
   ============================================================ */
export async function getProducts() {
  const { rows } = await query(
    `SELECT id, product_name, provider, bill_type, description, category, price, is_active
       FROM electricity_bills
      WHERE is_active = true
      ORDER BY provider ASC, bill_type ASC`
  );

  /* Group by provider for the frontend */
  const byProvider = new Map();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) {
      byProvider.set(r.provider, {
        provider: r.provider,
        products: [],
      });
    }
    byProvider.get(r.provider).products.push({
      id:           r.id,
      product_name: r.product_name,
      bill_type:    r.bill_type,
      description:  r.description,
      category:     r.category,
      min_amount:   MIN_AMOUNT,
      max_amount:   MAX_AMOUNT,
    });
  }

  return {
    providers: Array.from(byProvider.values()),
    min_amount: MIN_AMOUNT,
    max_amount: MAX_AMOUNT,
  };
}

/* ============================================================
   VERIFY METER
   ============================================================ */
export async function verifyMeter({ productName, meterNumber }) {
  const pn = String(productName || '').trim();
  const meter = normalizeMeter(meterNumber);

  if (!pn) throw Object.assign(new Error('Product is required'), { code: 'INVALID_PRODUCT' });
  if (!meter) throw Object.assign(new Error('Meter number is required'), { code: 'INVALID_METER' });
  if (!/^\d{11,13}$/.test(meter)) {
    throw Object.assign(new Error('Meter number must be 11 to 13 digits'), { code: 'INVALID_METER' });
  }

  /* Product must exist + be active */
  const { rows } = await query(
    `SELECT id, product_name, provider, bill_type, is_active
       FROM electricity_bills
      WHERE product_name = $1
      LIMIT 1`,
    [pn]
  );
  const bill = rows[0];
  if (!bill)             throw Object.assign(new Error('Product not found'), { code: 'INVALID_PRODUCT' });
  if (bill.is_active !== true)
                          throw Object.assign(new Error('This product is currently unavailable'), { code: 'PRODUCT_UNAVAILABLE' });

  /* Call DataShop */
  const result = await datashop.verifyElectricityMeter({
    meterNumber: meter,
    productName: pn,
  });

  /* Minimum = max(DataShop's, our floor) */
  const providerMin = Number(result.minimum_amount || 0) || 0;
  const minimum     = Math.max(MIN_AMOUNT, providerMin);

  return {
    verified:            true,
    product_name:        pn,
    provider:            bill.provider,
    bill_type:           bill.bill_type,
    meter_number:        result.meter_number,
    customer_name:       result.customer_name,
    customer_address:    result.customer_address,
    disco:               result.disco,
    minimum_amount:      minimum,
    maximum_amount:      MAX_AMOUNT,
    outstanding_balance: result.outstanding_balance,
  };
}

/* ============================================================
   PURCHASE ELECTRICITY
   ============================================================ */
export async function purchaseElectricity({
  userId, productName, meterNumber, amount, paymentMethod = 'wallet',
}) {
  if (!userId) throw Object.assign(new Error('User ID is required'), { code: 'UNAUTHORIZED' });

  const pn    = String(productName || '').trim();
  const meter = normalizeMeter(meterNumber);
  const amt   = money(amount);

  if (!pn)                              throw Object.assign(new Error('Product is required'), { code: 'INVALID_PRODUCT' });
  if (!meter)                           throw Object.assign(new Error('Meter number is required'), { code: 'INVALID_METER' });
  if (!/^\d{11,13}$/.test(meter))       throw Object.assign(new Error('Meter number must be 11 to 13 digits'), { code: 'INVALID_METER' });
  if (!Number.isFinite(amt) || amt <= 0)
                                        throw Object.assign(new Error('Amount must be positive'), { code: 'INVALID_AMOUNT' });
  if (amt < MIN_AMOUNT)                 throw Object.assign(new Error(`Minimum amount is ₦${MIN_AMOUNT.toLocaleString()}`), { code: 'AMOUNT_TOO_LOW' });
  if (amt > MAX_AMOUNT)                 throw Object.assign(new Error(`Maximum amount is ₦${MAX_AMOUNT.toLocaleString()}`), { code: 'AMOUNT_TOO_HIGH' });

  /* Load product */
  const { rows: billRows } = await query(
    `SELECT id, product_name, provider, bill_type, is_active, price
       FROM electricity_bills
      WHERE product_name = $1
      LIMIT 1`,
    [pn]
  );
  const bill = billRows[0];
  if (!bill)                            throw Object.assign(new Error('Product not found'), { code: 'INVALID_PRODUCT' });
  if (bill.is_active !== true)          throw Object.assign(new Error('This product is currently unavailable'), { code: 'PRODUCT_UNAVAILABLE' });

  /* Reference — our merchant reference, echoed back by DataShop */
  const reference = datashop.generateReference('SHATOVA-ELEC');

  /* ── 1. INSERT transactions (PENDING) ── */
  const { rows: txRows } = await query(
    `INSERT INTO transactions
       (user_id, reference, type, service, direction, amount, status,
        description, metadata, network,
        cost_price, profit, final_amount, discount, provider_ref, provider_status,
        created_at, updated_at)
     VALUES ($1, $2, 'ELECTRICITY', 'electricity', 'DEBIT', $3, 'PENDING',
             $4, $5::jsonb, $6,
             $7, $8, $9, 0, NULL, NULL,
             NOW(), NOW())
     RETURNING *`,
    [
      userId,
      reference,
      amt,
      `${bill.provider} ${bill.bill_type} ${meter} → ₦${amt}`,
      JSON.stringify({
        provider:        bill.provider,
        product_name:    pn,
        bill_type:       bill.bill_type,
        meter_number:    meter,
        user_price:      amt,
        payment_method:  paymentMethod,
        datashop_submitted: false,
      }),
      bill.provider.toUpperCase(),
      amt,   // provisional cost_price — will be overwritten by DataShop response
      0,     // provisional profit
      amt,   // final_amount = user price (Option C, no user discount)
    ]
  );
  const tx = txRows[0];

  /* ── 2. INSERT bill_payments (pending, linked to tx) ── */
  const { rows: bpRows } = await query(
    `INSERT INTO bill_payments
       (user_id, bill_id, meter_number, amount, status, transaction_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
     RETURNING *`,
    [userId, bill.id, meter, amt, tx.id]
  );
  const bp = bpRows[0];

  let finalStatus  = 'failed';
  let remark       = 'Unknown error';
  let dsResult     = null;
  let held         = false;
  let walletBefore = null;
  let walletAfter  = null;
  let caughtErr    = null;
  let dsCost       = amt;
  let dsProfit     = 0;
  let ambiguous    = false;
  let submitted    = false;
  let token        = null;
  let units        = null;
  let providerRef  = reference;

  try {
    /* ── 3. Place hold ── */
    if (paymentMethod === 'wallet') {
      const w = await wallet.getWallet(userId);
      if (!w) throw Object.assign(new Error('Wallet not found'), { code: 'WALLET_NOT_FOUND' });
      if (w.status !== 'ACTIVE')
        throw Object.assign(new Error('Wallet is not active'), { code: 'WALLET_INACTIVE' });

      walletBefore = money(w.balance);
      const holdResult = await wallet.holdFunds({
        userId,
        amount: amt,
        reference,
        description: `${bill.provider} ${bill.bill_type} — ${meter}`,
      });
      held        = true;
      walletAfter = money(holdResult.balance_after);
    }

    /* ── 4. Write intent flag before calling DataShop ── */
    await markDatashopSubmitted(reference);
    submitted = true;

    /* ── 5. Call DataShop ── */
    dsResult = await datashop.buyElectricity({
      meterNumber: meter,
      productName: pn,
      amount:      amt,
      reference,
    });

    /* ── 6. Interpret result ── */
    const normalized = datashop.normalizeProviderStatus(dsResult.raw || dsResult);
    const paidAmount = Number(dsResult.paid_amount || 0) || amt;

    token       = dsResult.token       || null;
    units       = dsResult.units       || null;
    providerRef = dsResult.provider_reference || reference;
    dsCost      = paidAmount;
    dsProfit    = money(amt - dsCost);

    if (normalized === 'successful') {
      finalStatus = 'success';
      remark      = dsResult.remark || 'Electricity purchase successful';
    } else if (normalized === 'failed') {
      finalStatus = 'failed';
      remark      = dsResult.remark || 'Purchase failed';
    } else {
      finalStatus = 'processing';
      ambiguous   = true;
      remark      = 'Taking longer than usual. We are confirming with the provider.';
    }
  } catch (err) {
    caughtErr = err;

    const isTimeout = err.code === 'PROVIDER_NETWORK' || err.isNetworkError;
    const isReject  = err.code === 'PROVIDER_REJECTED';

    if (isTimeout && submitted) {
      finalStatus = 'processing';
      ambiguous   = true;
      remark      = 'Taking longer than usual. We are confirming with the provider.';
    } else {
      finalStatus = 'failed';
      remark      = err.message || 'Purchase failed';
    }
  }

  /* ── 7. Release or drop hold ── */
  if (held) {
    if (finalStatus === 'success') {
      try {
        await wallet.releaseHold({
          userId,
          reference,
          transactionId: tx.id,
          description: `${bill.provider} ${bill.bill_type} — ${meter}`,
        });
      } catch (err) {
        console.error('[electricity] releaseHold failed:', err.message);
      }
    } else if (finalStatus === 'failed') {
      try {
        await wallet.dropHold({ userId, reference });
      } catch (err) {
        console.error('[electricity] dropHold failed:', err.message);
      }
    }
    /* processing → leave HELD */
  }

  /* ── 8. Persist final state on transactions ── */
  const dsRaw = dsResult?.raw || {};
  const metadata = {
    ds_reference:        dsRaw.reference || providerRef,
    ds_status:           dsRaw.transaction_status || '',
    ds_quantity:         dsRaw.quantity || null,
    ds_units:            units,
    ds_provider:         dsRaw.provider || bill.provider,
    ds_disco:            dsRaw.disco || null,
    ds_paid_amount:      dsCost,
    ds_customer_name:    dsRaw.customer_name    || null,
    ds_customer_address: dsRaw.customer_address || null,
    wallet_before:       walletBefore,
    wallet_after:        walletAfter,
    ambiguous,
    datashop_submitted:  submitted,
    reconcile_attempts:  0,
    reconcile_next_at:   finalStatus === 'processing'
      ? new Date(Date.now() + RECONCILE_FIRST_MS).toISOString()
      : null,
  };

  await updateTransaction(reference, {
    status:             finalStatus.toUpperCase(),
    description:        remark,
    remark,
    provider_reference: providerRef,
    provider_ref:       providerRef,
    provider_status:    dsRaw.transaction_status || null,
    cost_price:         dsCost,
    profit:             dsProfit,
    final_amount:       amt,
    discount:           0,
    metadata,
  });

  /* ── 9. Persist bill_payments final state ── */
  const billStatus =
    finalStatus === 'success'    ? 'success' :
    finalStatus === 'failed'     ? 'failed'  :
    'pending';

  await query(
    `UPDATE bill_payments
        SET status = $1,
            token = COALESCE($2, token),
            provider_reference = COALESCE($3, provider_reference),
            updated_at = NOW()
      WHERE id = $4`,
    [billStatus, token, providerRef, bp.id]
  );

  /* ── 10. Provider-level audit events (only we know these) ── */
  if (finalStatus === 'success') {
    await writeProviderAudit('provider_success', {
      userId, reference, amount: amt,
      source: 'electricity.service',
      details: {
        service:         'electricity',
        product_name:    pn,
        provider:        bill.provider,
        bill_type:       bill.bill_type,
        meter_number:    meter,
        customer_name:   dsRaw.customer_name    || null,
        customer_address:dsRaw.customer_address || null,
        disco:           dsRaw.disco            || null,
        token,
        units,
        paid_amount:     dsCost,
        profit:          dsProfit,
        quantity:        dsRaw.quantity || amt,
        provider_reference: providerRef,
      },
    });
  } else if (finalStatus === 'failed') {
    await writeProviderAudit('provider_failed', {
      userId, reference, amount: amt,
      source: 'electricity.service',
      details: {
        service: 'electricity', product_name: pn,
        meter_number: meter, provider: bill.provider,
        reason: remark,
        error_code: caughtErr?.code || null,
      },
    });
  } else if (finalStatus === 'processing') {
    await writeProviderAudit('provider_timeout', {
      userId, reference, amount: amt,
      source: 'electricity.service',
      details: {
        service: 'electricity', product_name: pn,
        meter_number: meter, provider: bill.provider,
        reason: remark,
      },
    });
  }

  /* ── 11. Definite errors are thrown; ambiguous returns normally ── */
  if (caughtErr && finalStatus === 'failed') {
    const e = new Error(caughtErr.message || 'Purchase failed');
    e.code  = caughtErr.code || 'PURCHASE_FAILED';
    e.data  = { reference };
    throw e;
  }

  return {
    reference,
    status:             finalStatus,
    ambiguous,
    product_name:       pn,
    provider:           bill.provider,
    bill_type:          bill.bill_type,
    meter_number:       meter,
    amount:             amt,
    final_amount:       amt,
    cost_price:         dsCost,
    profit:             dsProfit,
    discount:           0,
    token,
    units,
    customer_name:      dsRaw.customer_name    || null,
    customer_address:   dsRaw.customer_address || null,
    disco:              dsRaw.disco            || null,
    provider_reference: providerRef,
    remark,
    wallet_before:      walletBefore,
    wallet_after:       walletAfter,
  };
}

/* ============================================================
   GET STATUS
   ============================================================ */
export async function getStatus(reference) {
  if (!reference) throw new Error('reference is required');

  const tx = await findTransactionByReference(reference);
  if (!tx) throw new Error('Transaction not found');

  const current = String(tx.status || '').toLowerCase();
  const meta    = tx.metadata || {};

  if (['success', 'failed'].includes(current)) {
    const bp = await findBillPaymentByReference(reference);
    return {
      reference:          tx.reference,
      status:             current,
      remark:             tx.remark || tx.description || '',
      amount:             Number(tx.amount) || 0,
      final_amount:       Number(tx.final_amount || tx.amount) || 0,
      cost_price:         Number(tx.cost_price || 0),
      profit:             Number(tx.profit || 0),
      product_name:       meta.product_name || '',
      provider:           meta.provider || '',
      bill_type:          meta.bill_type || '',
      meter_number:       meta.meter_number || '',
      token:              bp?.token || meta.ds_token || null,
      units:              meta.ds_units || null,
      customer_name:      meta.ds_customer_name    || null,
      customer_address:   meta.ds_customer_address || null,
      disco:              meta.ds_disco            || null,
      provider_reference: tx.provider_reference || meta.ds_reference || null,
    };
  }

  if (meta.datashop_submitted === false) {
    return {
      reference: reference,
      status:    current === 'pending' ? 'processing' : current,
      remark:    tx.remark || tx.description || 'Preparing to submit…',
      amount:    Number(tx.amount) || 0,
      product_name: meta.product_name || '',
      provider:     meta.provider || '',
      meter_number: meta.meter_number || '',
    };
  }

  /* Still processing — ask DataShop */
  let ds;
  try {
    ds = await datashop.checkElectricityStatus(reference);
  } catch {
    return {
      reference,
      status:       'processing',
      remark:       tx.remark || tx.description || 'Still processing',
      amount:       Number(tx.amount) || 0,
      product_name: meta.product_name || '',
      provider:     meta.provider || '',
      meter_number: meta.meter_number || '',
    };
  }

  const normalized = datashop.normalizeProviderStatus(ds);
  const payload    = ds?.data || ds || {};

  let newStatus = 'processing';
  if (normalized === 'successful') newStatus = 'success';
  else if (normalized === 'failed') newStatus = 'failed';

  if (newStatus !== 'processing' && newStatus !== current) {
    /* Close out the hold */
    try {
      if (newStatus === 'success') {
        await wallet.releaseHold({
          userId: tx.user_id, reference, transactionId: tx.id,
          description: tx.description,
        });
      } else {
        await wallet.dropHold({ userId: tx.user_id, reference });
      }
    } catch (err) {
      console.warn('[electricity.getStatus] wallet op:', err.message);
    }

    const dsCost   = Number(payload.paid_amount || tx.cost_price || tx.amount || 0);
    const amt      = Number(tx.amount);
    const dsProfit = money(amt - dsCost);
    const tokenOut = payload.token || null;
    const unitsOut = payload.units || null;

    await updateTransaction(reference, {
      status:             newStatus.toUpperCase(),
      description:        payload.remark || 'Updated',
      remark:             payload.remark || 'Updated',
      provider_reference: payload.reference || reference,
      provider_ref:       payload.reference || reference,
      provider_status:    payload.transaction_status || null,
      cost_price:         dsCost,
      profit:             dsProfit,
      metadata: {
        ds_status:           payload.transaction_status || '',
        ds_quantity:         payload.quantity || null,
        ds_units:            unitsOut,
        ds_customer_name:    payload.customer_name    || null,
        ds_customer_address: payload.customer_address || null,
        ds_disco:            payload.disco            || null,
      },
    });

    await query(
      `UPDATE bill_payments
          SET status = $1,
              token = COALESCE($2, token),
              provider_reference = COALESCE($3, provider_reference),
              updated_at = NOW()
        WHERE transaction_id = $4`,
      [newStatus === 'success' ? 'success' : 'failed', tokenOut, payload.reference || reference, tx.id]
    );

    await writeProviderAudit(
      newStatus === 'success' ? 'provider_success' : 'provider_failed',
      {
        userId: tx.user_id, reference, amount: amt,
        source: 'electricity.service.getStatus',
        details: {
          service: 'electricity', product_name: meta.product_name || '',
          meter_number: meta.meter_number || '',
          token: tokenOut, units: unitsOut, paid_amount: dsCost,
        },
      }
    );
  }

  return {
    reference,
    status:             newStatus,
    remark:             payload.remark || tx.remark || tx.description || '',
    amount:             Number(tx.amount) || 0,
    final_amount:       Number(tx.final_amount || tx.amount) || 0,
    cost_price:         Number(tx.cost_price || 0),
    profit:             Number(tx.profit || 0),
    product_name:       meta.product_name || '',
    provider:           meta.provider || '',
    bill_type:          meta.bill_type || '',
    meter_number:       meta.meter_number || '',
    token:              payload.token || null,
    units:              payload.units || null,
    customer_name:      payload.customer_name    || meta.ds_customer_name    || null,
    customer_address:   payload.customer_address || meta.ds_customer_address || null,
    disco:              payload.disco            || meta.ds_disco            || null,
    provider_reference: payload.reference || tx.provider_reference || null,
  };
}

/* ============================================================
   HISTORY — user's past electricity payments
   ============================================================ */
export async function getHistory({ userId, limit = 20 } = {}) {
  if (!userId) throw new Error('userId is required');
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const { rows } = await query(
    `SELECT
        t.reference, t.amount, t.status, t.remark, t.created_at,
        t.cost_price, t.profit, t.final_amount,
        t.metadata,
        bp.token, bp.meter_number, bp.provider_reference
       FROM transactions t
       LEFT JOIN bill_payments bp ON bp.transaction_id = t.id
      WHERE t.user_id = $1
        AND t.service = 'electricity'
        AND t.type    = 'ELECTRICITY'
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [userId, n]
  );

  return rows.map((r) => ({
    reference:          r.reference,
    status:             String(r.status || '').toLowerCase(),
    amount:             Number(r.amount) || 0,
    final_amount:       Number(r.final_amount || r.amount) || 0,
    cost_price:         Number(r.cost_price || 0),
    profit:             Number(r.profit || 0),
    product_name:       r.metadata?.product_name || '',
    provider:           r.metadata?.provider || '',
    bill_type:          r.metadata?.bill_type || '',
    meter_number:       r.meter_number || r.metadata?.meter_number || '',
    token:              r.token || null,
    units:              r.metadata?.ds_units || null,
    customer_name:      r.metadata?.ds_customer_name || null,
    customer_address:   r.metadata?.ds_customer_address || null,
    disco:              r.metadata?.ds_disco || null,
    provider_reference: r.provider_reference || null,
    remark:             r.remark || '',
    created_at:         r.created_at,
  }));
}

/* ============================================================
   RECONCILER — call from cron every 60s
   ============================================================ */
export async function reconcileProcessingElectricityTransactions(limit = 50) {
  const { rows } = await query(
    `SELECT id, reference, user_id, amount, cost_price, status, metadata, remark, description, created_at
       FROM transactions
      WHERE type = 'ELECTRICITY'
        AND service = 'electricity'
        AND status IN ('PROCESSING', 'PENDING')
        AND (
          (metadata->>'reconcile_next_at') IS NULL
          OR (metadata->>'reconcile_next_at')::timestamptz <= NOW()
        )
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  if (!rows.length) return { checked: 0, finalized: 0, stillPending: 0, refunded: 0 };

  let finalized = 0, stillPending = 0, refunded = 0;

  for (const tx of rows) {
    const ref  = tx.reference;
    const meta = tx.metadata || {};
    const attempts = Number(meta.reconcile_attempts || 0);
    const ageMs    = Date.now() - new Date(tx.created_at).getTime();
    const ageMin   = Math.floor(ageMs / 60000);

    /* Case 1 — never submitted */
    const submitted = meta.datashop_submitted;
    if ((submitted === false || submitted === undefined) && ageMs > 30_000) {
      await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});
      await updateTransaction(ref, {
        status: 'FAILED',
        description: 'Purchase never reached provider — refunded',
        remark:      'Purchase never reached provider — refunded',
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

    /* Case 2 — check with DataShop */
    try {
      const ds = await datashop.checkElectricityStatus(ref);
      const normalized = datashop.normalizeProviderStatus(ds);
      const payload = ds?.data || ds || {};

      if (normalized === 'successful') {
        await wallet.releaseHold({
          userId: tx.user_id, reference: ref, transactionId: tx.id,
          description: tx.description,
        }).catch(() => {});

        const dsCost = Number(payload.paid_amount || tx.cost_price || 0);
        const amt    = Number(tx.amount);
        const profit = money(amt - dsCost);
        const tokenOut = payload.token || null;

        await updateTransaction(ref, {
          status: 'SUCCESS',
          description: payload.remark || 'Purchase successful',
          remark:      payload.remark || 'Purchase successful',
          provider_reference: payload.reference || meta.ds_reference || ref,
          provider_ref:       payload.reference || meta.ds_reference || ref,
          provider_status:    payload.transaction_status || null,
          cost_price: dsCost,
          profit,
          metadata: {
            ds_status: payload.transaction_status || '',
            ds_units:  payload.units || null,
            ds_customer_name:    payload.customer_name    || null,
            ds_customer_address: payload.customer_address || null,
            ds_disco:            payload.disco            || null,
            reconcile_attempts: attempts + 1,
            reconcile_next_at: null,
            reconciled_at: new Date().toISOString(),
          },
        });

        await query(
          `UPDATE bill_payments
              SET status = 'success',
                  token  = COALESCE($1, token),
                  provider_reference = COALESCE($2, provider_reference),
                  updated_at = NOW()
            WHERE transaction_id = $3`,
          [tokenOut, payload.reference || ref, tx.id]
        );

        await writeProviderAudit('provider_success', {
          userId: tx.user_id, reference: ref, amount: amt,
          source: 'electricity.reconciler',
          details: {
            service: 'electricity',
            token: tokenOut, units: payload.units || null,
            paid_amount: dsCost, profit,
            meter_number: meta.meter_number || '',
            product_name: meta.product_name || '',
          },
        });

        finalized++;
      } else if (normalized === 'failed') {
        await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});

        await updateTransaction(ref, {
          status: 'FAILED',
          description: payload.remark || 'Purchase failed',
          remark:      payload.remark || 'Purchase failed',
          provider_status: payload.transaction_status || null,
          metadata: {
            ds_status: payload.transaction_status || '',
            reconcile_attempts: attempts + 1,
            reconcile_next_at: null,
            reconciled_at: new Date().toISOString(),
          },
        });

        await query(
          `UPDATE bill_payments
              SET status = 'failed', updated_at = NOW()
            WHERE transaction_id = $1`,
          [tx.id]
        );

        await writeProviderAudit('provider_failed', {
          userId: tx.user_id, reference: ref, amount: Number(tx.amount),
          source: 'electricity.reconciler',
          details: { service: 'electricity', reason: payload.remark || 'failed' },
        });

        finalized++;
      } else {
        /* still processing */
        if (attempts + 1 >= RECONCILE_MAX_ATTEMPTS) {
          await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});
          await updateTransaction(ref, {
            status: 'FAILED',
            description: 'Could not confirm with provider. Amount reversed.',
            remark:      'Could not confirm with provider. Amount reversed.',
            metadata: {
              reconcile_attempts: attempts + 1,
              reconcile_next_at: null,
              reconciled_at: new Date().toISOString(),
              reconciled_reason: 'max_attempts_exceeded',
            },
          });
          await query(
            `UPDATE bill_payments SET status='failed', updated_at=NOW() WHERE transaction_id=$1`,
            [tx.id]
          );
          finalized++;
        } else {
          await updateTransaction(ref, {
            metadata: {
              reconcile_attempts: attempts + 1,
              reconcile_next_at: new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString(),
              last_checked_at:   new Date().toISOString(),
            },
          });
          stillPending++;
        }
      }
    } catch (err) {
      const isNotFound =
        err.code === 'PROVIDER_NOT_FOUND' ||
        /not found on DataShop/i.test(err.message || '');

      if (isNotFound) {
        const newAttempts   = attempts + 1;
        const notFoundCount = Number(meta.not_found_count || 0) + 1;

        if (notFoundCount >= RECONCILE_MAX_ATTEMPTS &&
            ageMin >= MIN_AGE_BEFORE_NOT_FOUND_REFUND) {
          await wallet.dropHold({ userId: tx.user_id, reference: ref }).catch(() => {});
          await updateTransaction(ref, {
            status: 'FAILED',
            description: 'Not received by provider after 2h — auto-refunded',
            remark:      'Not received by provider after 2h — auto-refunded',
            metadata: {
              reconcile_attempts: newAttempts,
              not_found_count: notFoundCount,
              reconcile_result: 'not_found_after_2h',
              reconcile_next_at: null,
              reconciled_at: new Date().toISOString(),
            },
          });
          await query(
            `UPDATE bill_payments SET status='failed', updated_at=NOW() WHERE transaction_id=$1`,
            [tx.id]
          );
          finalized++;
        } else {
          await updateTransaction(ref, {
            metadata: {
              reconcile_attempts: newAttempts,
              not_found_count: notFoundCount,
              reconcile_next_at: new Date(Date.now() + RECONCILE_INTERVAL_MS * 5).toISOString(),
              last_not_found_at: new Date().toISOString(),
              waiting_reason: 'datashop_index_delay',
            },
          }).catch(() => {});
          stillPending++;
        }
      } else {
        await updateTransaction(ref, {
          metadata: {
            reconcile_attempts: attempts + 1,
            reconcile_next_at: new Date(Date.now() + RECONCILE_INTERVAL_MS).toISOString(),
            last_error: String(err.message || '').slice(0, 200),
          },
        }).catch(() => {});
        stillPending++;
      }
    }
  }

  return { checked: rows.length, finalized, refunded, stillPending };
}
