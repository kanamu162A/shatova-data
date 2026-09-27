// controllers/airtime.controller.js
// ============================================================
// Airtime purchase — wallet-backed, race-safe, idempotent
//   Networks: MTN · Airtel · Glo · T2
// ============================================================

import { query, withTransaction } from '../config/database.js';
import { env } from '../env/env.js';
import {
  buyAirtime,
  checkAirtimeStatus,
  normalizeProviderStatus,
  normalizeProviderError,
} from '../services/vtu.service.js';
import { holdFunds, releaseHold, dropHold } from '../services/wallet.service.js';
import { generateReference } from '../utils/reference.js';
import { buildRemark } from '../utils/remark.js';

/* ============================================================
   NETWORKS — T2 only. No 9mobile.
   ============================================================ */
const NETWORKS = [
  { key: 'mtn',    name: 'MTN',    product_name: 'mtn-airtime'    },
  { key: 'airtel', name: 'Airtel', product_name: 'airtel-airtime' },
  { key: 'glo',    name: 'Glo',    product_name: 'glo-airtime'    },
  { key: 't2',     name: 'T2',     product_name: 't2-airtime'     },
];

const PRODUCT_NAME_FALLBACKS = {
  mtn:    ['mtn-airtime', 'mtn'],
  airtel: ['airtel-airtime', 'airtel'],
  glo:    ['glo-airtime', 'glo', 'globacom-airtime', 'glo-mobile'],
  t2:     ['t2-airtime', 't2'],
};

const MIN = 10;
const MAX = 50000;

const USER_DISCOUNT_PERCENT     = env.AIRTIME_USER_DISCOUNT     || 2;
const USER_DISCOUNT_MIN_AMOUNT  = env.AIRTIME_USER_DISCOUNT_MIN || 100;
const DATASHOP_DISCOUNT_PERCENT = env.AIRTIME_DATASHOP_DISCOUNT || 3;

/* ⭐ T2 prefixes only — no 9mobile key */
const NG_PREFIXES = {
  mtn:    ['0803','0806','0703','0706','0813','0816','0810','0814','0903','0906','0913','0916','0704'],
  airtel: ['0802','0808','0708','0812','0701','0902','0901','0907','0912','0911'],
  glo:    ['0805','0807','0705','0815','0811','0905','0915'],
  t2:     ['0809','0817','0818','0908','0909'],
};
const MTN_5DIGIT = ['07025', '07026'];

function detectNetworkFromPrefix(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length !== 11 || !p.startsWith('0')) return null;
  const p4 = p.slice(0, 4);
  const p5 = p.slice(0, 5);
  if (MTN_5DIGIT.includes(p5)) return 'mtn';
  for (const [network, prefixes] of Object.entries(NG_PREFIXES)) {
    if (prefixes.includes(p4)) return network;
  }
  return null;
}

function calculateUserPrice(amount) {
  if (amount >= USER_DISCOUNT_MIN_AMOUNT) {
    const discount = amount * (USER_DISCOUNT_PERCENT / 100);
    return Math.round((amount - discount) * 100) / 100;
  }
  return amount;
}

function calculateCost(userAmount) {
  const cost = userAmount * (1 - DATASHOP_DISCOUNT_PERCENT / 100);
  return Math.round(cost * 100) / 100;
}

function isProductNotFound(err) {
  const raw = String(err?.rawMessage || err?.message || '').toLowerCase();
  return raw.includes('product')
      || raw.includes('not found')
      || raw.includes('invalid')
      || raw.includes('unknown')
      || raw.includes('service');
}

/* ============================================================
   GET /airtime/networks
   ============================================================ */
export function getNetworks(req, res) {
  res.json({
    success: true,
    data: { networks: NETWORKS.map((n) => ({ key: n.key, name: n.name })) },
  });
}

/* ============================================================
   GET /airtime/products
   ============================================================ */
export function getProducts(req, res) {
  const key = String(req.query.network || '').toLowerCase();
  const net = NETWORKS.find((n) => n.key === key);
  if (!net) return res.status(404).json({ success: false, message: 'Unknown network' });

  res.json({
    success: true,
    data: {
      products: [{
        id: net.product_name,
        provider: net.key,
        name: `${net.name} Airtime`,
        description: `${net.name} Instant recharge`,
        discount: USER_DISCOUNT_PERCENT,
        discount_min: USER_DISCOUNT_MIN_AMOUNT,
        available: true,
      }],
    },
  });
}

/* ============================================================
   GET /airtime/config
   ============================================================ */
export function getConfig(req, res) {
  res.json({
    success: true,
    data: {
      user_discount_percent: USER_DISCOUNT_PERCENT,
      user_discount_min_amount: USER_DISCOUNT_MIN_AMOUNT,
      min_amount: MIN,
      max_amount: MAX,
    },
  });
}

/* ============================================================
   GET /airtime/balance
   ============================================================ */
export async function getBalance(req, res) {
  try {
    const { rows } = await query(
      `SELECT balance, held_balance, daily_limit, daily_spent, status
         FROM wallets WHERE user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }
    const w = rows[0];
    res.json({
      success: true,
      data: {
        balance:         Number(w.balance),
        held_balance:    Number(w.held_balance || 0),
        daily_limit:     Number(w.daily_limit),
        daily_spent:     Number(w.daily_spent),
        daily_remaining: Math.max(0, Number(w.daily_limit) - Number(w.daily_spent)),
        status:          w.status,
      },
    });
  } catch (err) {
    console.error('[airtime] getBalance:', err);
    res.status(500).json({ success: false, message: 'Could not fetch balance' });
  }
}

/* ============================================================
   GET /airtime/status
   ============================================================ */
export async function getTransactionStatus(req, res) {
  try {
    const reference = String(req.query.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ success: false, message: 'Reference is required.' });
    }

    const { rows } = await query(
      `SELECT id, reference, status, description, metadata,
              provider_reference, updated_at
         FROM transactions
        WHERE reference = $1 AND user_id = $2`,
      [reference, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const tx = rows[0];
    const dbStatus = String(tx.status || '').toUpperCase();

    if (dbStatus === 'PROCESSING' || dbStatus === 'PENDING') {
      try {
        const check = await checkAirtimeStatus(reference);
        const providerStatus = normalizeProviderStatus(check);

        const meta       = tx.metadata || {};
        const networkKey = meta.network || '';
        const phone      = meta.phone || '';
        const amount     = Number(meta.user_paid || 0);

        if (providerStatus === 'successful') {
          await releaseHold({
            userId: req.user.id,
            reference,
            transactionId: tx.id,
            description: tx.description,
          });

          const remark = buildRemark({
            status: 'success',
            network: networkKey,
            phone,
            amount,
            service: 'airtime',
            discount: Number(meta.user_discount_amt || 0),
          });

          await query(
            `UPDATE transactions
                SET status = 'SUCCESS',
                    provider_reference = COALESCE($1, provider_reference),
                    metadata   = metadata || $2::jsonb,
                    description = $3,
                    updated_at  = NOW()
              WHERE id = $4`,
            [check?.data?.reference || null, JSON.stringify({ status_check: check }), remark, tx.id]
          );
          tx.status = 'SUCCESS';
          tx.description = remark;

        } else if (providerStatus === 'failed') {
          await dropHold({ userId: req.user.id, reference });

          const safeMessage = normalizeProviderError(check?.message || check?.data?.remark);

          const remark = buildRemark({
            status: 'failed',
            code: 'PROVIDER_FAILED',
            providerMessage: safeMessage,
            network: networkKey,
            phone,
            amount,
            service: 'airtime',
          });

          await query(
            `UPDATE transactions
                SET status = 'FAILED',
                    metadata   = metadata || $1::jsonb,
                    description = $2,
                    updated_at  = NOW()
              WHERE id = $3`,
            [JSON.stringify({ status_check: check, reason: check?.message }), remark, tx.id]
          );
          tx.status = 'FAILED';
          tx.description = remark;
        }
      } catch (checkErr) {
        console.warn('[airtime/status] provider check failed:', checkErr.message);
      }
    }

    return res.json({
      success: true,
      data: {
        reference:          tx.reference,
        status:             String(tx.status || 'PENDING').toLowerCase(),
        remark:             tx.description,
        provider_reference: tx.provider_reference,
        updated_at:         tx.updated_at,
      },
    });
  } catch (err) {
    console.error('[airtime] getTransactionStatus:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch status.' });
  }
}

/* ============================================================
   POST /airtime/purchase
   ============================================================ */
export async function purchase(req, res) {
  const {
    network,
    phone,
    amount,
    product_id,
    payment_method = 'wallet',
    force_network = false,
  } = req.body || {};

  if (!network) return res.status(400).json({ success: false, message: 'Network is required' });
  if (!phone)   return res.status(400).json({ success: false, message: 'Phone is required' });

  const phoneDigits = String(phone).replace(/\D/g, '');
  if (!/^0\d{10}$/.test(phoneDigits)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_PHONE',
      message: 'Please enter a valid 11-digit Nigerian phone number.',
    });
  }

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < MIN) {
    return res.status(400).json({
      success: false,
      code: 'AMOUNT_TOO_LOW',
      message: `Minimum airtime amount is ₦${MIN}.`,
    });
  }
  if (amt > MAX) {
    return res.status(400).json({
      success: false,
      code: 'AMOUNT_TOO_HIGH',
      message: `Maximum is ₦${MAX.toLocaleString()}.`,
    });
  }
  if (payment_method !== 'wallet') {
    return res.status(400).json({
      success: false,
      code: 'UNSUPPORTED_PAYMENT',
      message: 'Only wallet payment is supported.',
    });
  }

  const net = NETWORKS.find((n) => n.key === String(network).toLowerCase());
  if (!net) {
    return res.status(400).json({
      success: false,
      code: 'UNSUPPORTED_NETWORK',
      message: 'That network is not supported.',
    });
  }

  const prefixNetwork = detectNetworkFromPrefix(phoneDigits);
  if (prefixNetwork && prefixNetwork !== net.key && !force_network) {
    const expectedName = NETWORKS.find((n) => n.key === prefixNetwork)?.name || prefixNetwork.toUpperCase();
    const remark = buildRemark({
      status: 'failed',
      code: 'NETWORK_MISMATCH',
      network: net.key,
      phone: phoneDigits,
      service: 'airtime',
    });
    return res.status(400).json({
      success: false,
      code: 'NETWORK_MISMATCH',
      message: remark,
      data: {
        detected_network: prefixNetwork,
        detected_name: expectedName,
        selected_network: net.key,
        selected_name: net.name,
        phone: phoneDigits,
        can_override: true,
        remark,
      },
    });
  }

  const userId    = req.user.id;
  const userPrice = calculateUserPrice(amt);
  const costPrice = calculateCost(amt);
  const profit    = Math.round((userPrice - costPrice) * 100) / 100;
  const hasDiscount   = userPrice < amt;
  const discountValue = Math.round((amt - userPrice) * 100) / 100;

  try {
    const { rows } = await query(
      `SELECT id, balance, held_balance, status, daily_limit, daily_spent, daily_reset_at
         FROM wallets WHERE user_id = $1`,
      [userId]
    );
    const wallet = rows[0];
    if (!wallet) {
      return res.status(404).json({ success: false, code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' });
    }
    if (wallet.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, code: 'WALLET_INACTIVE', message: 'Your wallet is not active.' });
    }

    const currentBalance = Number(wallet.balance);
    if (currentBalance < userPrice) {
      const shortfall = userPrice - currentBalance;
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        message: `Your wallet balance is ₦${currentBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}, but this purchase costs ₦${userPrice.toLocaleString('en-NG', { minimumFractionDigits: 2 })}. Please fund your wallet with at least ₦${shortfall.toLocaleString('en-NG', { minimumFractionDigits: 2 })} to continue.`,
        data: { balance: currentBalance, required: userPrice, shortfall },
      });
    }

    const lastReset = new Date(wallet.daily_reset_at);
    const now = new Date();
    const isNewDay =
      lastReset.getUTCFullYear() !== now.getUTCFullYear() ||
      lastReset.getUTCMonth()    !== now.getUTCMonth()    ||
      lastReset.getUTCDate()     !== now.getUTCDate();

    const dailySpent = isNewDay ? 0 : Number(wallet.daily_spent);
    const dailyLimit = Number(wallet.daily_limit);
    if (dailySpent + userPrice > dailyLimit) {
      const remaining = Math.max(0, dailyLimit - dailySpent);
      return res.status(400).json({
        success: false,
        code: 'DAILY_LIMIT_EXCEEDED',
        message: `You have reached your daily spending limit. You can spend up to ₦${remaining.toLocaleString('en-NG', { minimumFractionDigits: 2 })} more today.`,
      });
    }
  } catch (err) {
    console.error('[airtime] balance pre-check:', err);
    return res.status(500).json({ success: false, message: 'We could not verify your wallet balance.' });
  }

  const baseProductName = product_id || net.product_name;
  const reference = generateReference('SHAT');
  const internalDescription = `${net.name} Airtime ₦${amt} to ${phoneDigits}`;

  let holdResult;
  try {
    holdResult = await holdFunds({
      userId,
      amount: userPrice,
      reference,
      description: internalDescription,
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        message: err.message || 'Insufficient balance.',
        data: err.data,
      });
    }
    console.error('[airtime] holdFunds failed:', err);
    return res.status(500).json({
      success: false,
      code: err.code || 'HOLD_FAILED',
      message: err.message || 'Could not place hold on your wallet.',
    });
  }

  const initialRemark = buildRemark({
    status: 'processing',
    network: net.key,
    phone: phoneDigits,
    amount: userPrice,
    service: 'airtime',
  });

  let transactionId;
  try {
    const ins = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO transactions
           (user_id, reference, type, service, direction, amount,
            cost_price, profit, status, description, metadata)
         VALUES ($1, $2, 'VTU', 'AIRTIME', 'DEBIT', $3, $4, $5, 'PENDING', $6, $7::jsonb)
         RETURNING id`,
        [
          userId,
          reference,
          userPrice,
          costPrice,
          profit,
          initialRemark,
          JSON.stringify({
            network: net.key,
            network_name: net.name,
            phone: phoneDigits,
            product_name: baseProductName,
            mode: 'single',
            payment_method: 'wallet',
            airtime_value: amt,
            user_paid: userPrice,
            user_discount_pct: hasDiscount ? USER_DISCOUNT_PERCENT : 0,
            user_discount_amt: discountValue,
            datashop_cost: costPrice,
            datashop_discount: DATASHOP_DISCOUNT_PERCENT,
            profit: profit,
            balance_before: holdResult.balance_before,
            balance_after:  holdResult.balance_after,
            held: true,
            idempotent_hold: !!holdResult.idempotent,
          }),
        ]
      );
      return r.rows[0].id;
    });
    transactionId = ins;
  } catch (err) {
    await dropHold({ userId, reference }).catch(() => {});
    console.error('[airtime] insert transaction failed:', err);
    return res.status(500).json({ success: false, message: 'Could not record transaction.' });
  }

  const fallbackList = PRODUCT_NAME_FALLBACKS[net.key] || [baseProductName];
  const productsToTry = [baseProductName, ...fallbackList.filter(p => p !== baseProductName)];

  let result;
  let usedProductName = baseProductName;
  let lastErr;

  for (const pName of productsToTry) {
    try {
      result = await buyAirtime({
        customer_id: phoneDigits,
        product_name: pName,
        amount: amt,
        reference,
      });
      usedProductName = pName;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;

      if (isProductNotFound(err) && productsToTry.indexOf(pName) < productsToTry.length - 1) {
        console.warn(`[airtime] product "${pName}" rejected — trying next`);
        continue;
      }
      break;
    }
  }

  if (lastErr) {
    const apiErr = lastErr;
    const isAmbiguous = apiErr.isTimeout || apiErr.isNetworkError;

    if (isAmbiguous) {
      const remark = buildRemark({
        status: 'processing',
        network: net.key,
        phone: phoneDigits,
        service: 'airtime',
      });
      await query(
        `UPDATE transactions
            SET status = 'PROCESSING',
                metadata = metadata || $1::jsonb,
                description = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [JSON.stringify({ provider_error: apiErr.rawMessage || apiErr.message }), remark, transactionId]
      );
      return res.json({
        success: true,
        message: remark,
        data: {
          id: transactionId,
          reference,
          status: 'PROCESSING',
          remark,
          network: net.name,
          phone: phoneDigits,
          amount: userPrice,
          airtime_value: amt,
          discount_applied: hasDiscount,
          discount_percent: hasDiscount ? USER_DISCOUNT_PERCENT : 0,
          discount_amount: discountValue,
          balance: holdResult.balance_after,
        },
      });
    }

    await dropHold({ userId, reference });

    const safeMessage = normalizeProviderError(apiErr.rawMessage || apiErr.message);

    const remark = buildRemark({
      status: 'failed',
      code: 'PROVIDER_FAILED',
      providerMessage: safeMessage,
      network: net.key,
      phone: phoneDigits,
      amount: userPrice,
      service: 'airtime',
    });

    await query(
      `UPDATE transactions
          SET status = 'FAILED',
              metadata = metadata || $1::jsonb,
              description = $2,
              updated_at = NOW()
        WHERE id = $3`,
      [
        JSON.stringify({
          provider_error: apiErr.rawMessage || apiErr.message,
          tried_products: productsToTry,
        }),
        remark,
        transactionId,
      ]
    );

    return res.status(400).json({
      success: false,
      code: 'PROVIDER_FAILED',
      message: remark,
      data: { reference, refunded: true, remark },
    });
  }

  const providerStatus = normalizeProviderStatus(result);
  const providerRef = result?.data?.reference;

  if (providerStatus === 'successful') {
    await releaseHold({
      userId,
      reference,
      transactionId,
      description: internalDescription,
    });

    const remark = buildRemark({
      status: 'success',
      network: net.key,
      phone: phoneDigits,
      amount: userPrice,
      service: 'airtime',
      discount: discountValue,
    });

    await query(
      `UPDATE transactions
          SET status = 'SUCCESS',
              provider_reference = $1,
              provider_ref = $1,
              metadata = metadata || $2::jsonb,
              description = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [
        providerRef || null,
        JSON.stringify({ provider_response: result.data || result, product_used: usedProductName }),
        remark,
        transactionId,
      ]
    );

    return res.json({
      success: true,
      message: remark,
      data: {
        id: transactionId,
        reference,
        status: 'SUCCESS',
        remark,
        network: net.name,
        phone: phoneDigits,
        amount: userPrice,
        airtime_value: amt,
        discount_applied: hasDiscount,
        discount_percent: hasDiscount ? USER_DISCOUNT_PERCENT : 0,
        discount_amount: discountValue,
        balance: holdResult.balance_after,
      },
    });
  }

  if (providerStatus === 'processing') {
    const remark = buildRemark({
      status: 'processing',
      network: net.key,
      phone: phoneDigits,
      amount: userPrice,
      service: 'airtime',
    });
    await query(
      `UPDATE transactions
          SET status = 'PROCESSING',
              provider_reference = $1,
              provider_ref = $1,
              metadata = metadata || $2::jsonb,
              description = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [
        providerRef || null,
        JSON.stringify({ provider_response: result.data || result, product_used: usedProductName }),
        remark,
        transactionId,
      ]
    );
    return res.json({
      success: true,
      message: remark,
      data: {
        id: transactionId,
        reference,
        status: 'PROCESSING',
        remark,
        network: net.name,
        phone: phoneDigits,
        amount: userPrice,
        airtime_value: amt,
        discount_applied: hasDiscount,
        discount_percent: hasDiscount ? USER_DISCOUNT_PERCENT : 0,
        discount_amount: discountValue,
        balance: holdResult.balance_after,
      },
    });
  }

  await dropHold({ userId, reference });

  const safeMessage = normalizeProviderError(result?.message);

  const remark = buildRemark({
    status: 'failed',
    code: 'PROVIDER_FAILED',
    providerMessage: safeMessage,
    network: net.key,
    phone: phoneDigits,
    amount: userPrice,
    service: 'airtime',
  });
  await query(
    `UPDATE transactions
        SET status = 'FAILED',
            metadata = metadata || $1::jsonb,
            description = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [
      JSON.stringify({
        provider_response: result.data || result,
        reason: result?.message,
        product_used: usedProductName,
      }),
      remark,
      transactionId,
    ]
  );

  return res.status(400).json({
    success: false,
    code: 'PROVIDER_FAILED',
    message: remark,
    data: { reference, refunded: true, remark },
  });
}