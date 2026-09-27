// controllers/wallet.controller.js
// ============================================================
// User-facing wallet controller
//   • Reads: balance, ledger, transactions, recipients
//   • Fund wallet: writes a pending DEPOSIT row (no money moves)
//   • Deposit status: polled by fund-wallet.js
//   • Dev topup: direct credit
// ============================================================

import crypto from 'node:crypto';
import { query } from '../config/database.js';
import {
  getWallet,
  ensureWallet,
  creditWallet,
} from '../services/wallet.service.js';

/* ============================================================
   CONFIG
   ============================================================ */
const MIN_DEPOSIT = 100;
const MAX_DEPOSIT = 500_000;

const PAYMENT_ACCOUNT = Object.freeze({
  bank: 'Moniepoint MFB',
  account_number: '6034037129',
  account_name: 'Umar Mannir Abubakar',
});

/* ============================================================
   HELPERS
   ============================================================ */
function generateDepositRef() {
  const now = new Date();
  const ymd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `DEP-${ymd}-${rand}`;
}

function normalizeDepositStatus(raw) {
  const s = String(raw || 'pending').toLowerCase();
  if (['successful', 'completed', 'success', 'captured'].includes(s)) return 'successful';
  if (['failed', 'rejected', 'released', 'cancelled', 'canceled'].includes(s)) return 'failed';
  if (['processing'].includes(s)) return 'processing';
  return 'pending';
}

/* ============================================================
   GET /wallet/balance
   ============================================================ */
export async function getBalance(req, res) {
  try {
    const wallet = await getWallet(req.user.id);
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found.' });

    const balance     = Number(wallet.balance);
    const heldBalance = Number(wallet.held_balance || 0);

    return res.json({
      success: true,
      data: {
        balance,
        held_balance:    heldBalance,
        total:           Math.round((balance + heldBalance) * 100) / 100,
        status:          wallet.status,
        daily_limit:     Number(wallet.daily_limit || 0),
        daily_spent:     Number(wallet.daily_spent || 0),
        daily_remaining: Math.max(0, Number(wallet.daily_limit || 0) - Number(wallet.daily_spent || 0)),
      },
    });
  } catch (err) {
    console.error('[wallet] getBalance:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch wallet.' });
  }
}

/* ============================================================
   GET /wallet/ledger
   Raw ledger — one row per wallet movement.
   ============================================================ */
export async function getLedger(req, res) {
  try {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await query(
      `SELECT id, reference, type, direction, amount,
              balance_before, balance_after, description,
              COALESCE(status, 'successful') AS status, created_at
         FROM wallet_ledger
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const { rows: cnt } = await query(
      'SELECT COUNT(*)::int AS total FROM wallet_ledger WHERE user_id = $1',
      [req.user.id]
    );

    return res.json({
      success: true,
      data: {
        entries: rows.map((r) => ({
          id:             r.id,
          reference:      r.reference,
          type:           r.type,
          direction:      r.direction,
          amount:         Number(r.amount),
          balance_before: Number(r.balance_before),
          balance_after:  Number(r.balance_after),
          description:    r.description,
          status:         r.status,
          created_at:     r.created_at,
        })),
        total: cnt[0]?.total || 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('[wallet] getLedger:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch ledger.' });
  }
}

/* ============================================================
   GET /wallet/transactions
   Merged + deduplicated history — VTU purchases + wallet movements
   exactly once per reference.
   ============================================================ */
export async function getTransactions(req, res) {
  try {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const filter = String(req.query.type || 'all').toLowerCase();

    /* ── Filter conditions ───────────────────────────────────── */
    let txWhere = '';
    let wlWhere = '';

    if (filter === 'airtime') {
      txWhere = ` AND LOWER(COALESCE(service,'')) = 'airtime'`;
      wlWhere = ` AND 1 = 0`;
    } else if (filter === 'data') {
      txWhere = ` AND LOWER(COALESCE(service,'')) = 'data'`;
      wlWhere = ` AND 1 = 0`;
    } else if (filter === 'funding') {
      txWhere = ` AND 1 = 0`;
      wlWhere = ` AND type IN ('DEPOSIT','WALLET_TOPUP','TOPUP','FUNDING','DEPOSIT_REVERSAL')`;
    } else if (filter === 'refund') {
      txWhere = ` AND UPPER(status) IN ('REFUNDED','FAILED')`;
      wlWhere = ` AND type IN ('REFUND','DEPOSIT_REVERSAL')`;
    } else if (filter === 'failed') {
      txWhere = ` AND UPPER(status) = 'FAILED'`;
      wlWhere = ` AND 1 = 0`;
    }

    /* ── Deduplicated merge ─────────────────────────────────────
       Rules:
         1. VTU purchases — the `transactions` row wins; the
            matching `wallet_ledger` VTU_PURCHASE row is dropped.
         2. Deposits — if both a pending DEPOSIT and a successful
            WALLET_TOPUP exist with the same reference, only the
            WALLET_TOPUP (settlement) row is shown.
         3. Withdrawals — appear once from wallet_ledger.
    ──────────────────────────────────────────────────────────── */
    const { rows } = await query(
      `WITH filtered_tx AS (
         SELECT
           t.id, t.reference, t.type, t.service, t.direction,
           t.amount, t.status, t.description, t.metadata,
           t.provider_reference, t.created_at,
           'transaction'::varchar AS source
         FROM transactions t
         WHERE t.user_id = $1 ${txWhere}
       ),
       filtered_wl AS (
         SELECT
           wl.id, wl.reference, wl.type, NULL::varchar AS service, wl.direction,
           wl.amount, COALESCE(wl.status, 'successful') AS status,
           wl.description, '{}'::jsonb AS metadata,
           NULL::varchar AS provider_reference, wl.created_at,
           'wallet'::varchar AS source
         FROM wallet_ledger wl
         WHERE wl.user_id = $1 ${wlWhere}
       ),
       /* Wallet rows that don't have a matching transaction row */
       standalone_wallet AS (
         SELECT wl.*
           FROM filtered_wl wl
          WHERE NOT EXISTS (
                  SELECT 1 FROM filtered_tx t
                   WHERE t.reference = wl.reference
                )
       ),
       /* One row per reference — prefer the successful settlement */
       dedup_wallet AS (
         SELECT DISTINCT ON (reference) *
           FROM standalone_wallet
          ORDER BY reference,
                   CASE LOWER(status)
                     WHEN 'successful' THEN 0
                     WHEN 'completed'  THEN 0
                     WHEN 'success'    THEN 0
                     WHEN 'processing' THEN 1
                     WHEN 'pending'    THEN 2
                     WHEN 'rejected'   THEN 3
                     WHEN 'failed'     THEN 3
                     ELSE 4
                   END,
                   created_at DESC
       ),
       history AS (
         SELECT * FROM filtered_tx
         UNION ALL
         SELECT * FROM dedup_wallet
       )
       SELECT * FROM history
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    /* ── Deduplicated count ──────────────────────────────────── */
    const { rows: cnt } = await query(
      `WITH filtered_tx AS (
         SELECT reference FROM transactions t WHERE t.user_id = $1 ${txWhere}
       ),
       filtered_wl AS (
         SELECT reference FROM wallet_ledger wl WHERE wl.user_id = $1 ${wlWhere}
       ),
       standalone AS (
         SELECT reference FROM filtered_wl wl
          WHERE NOT EXISTS (
                  SELECT 1 FROM filtered_tx t WHERE t.reference = wl.reference
                )
       )
       SELECT
         (SELECT COUNT(*)::int FROM filtered_tx)
       + (SELECT COUNT(DISTINCT reference)::int FROM standalone) AS total`,
      [req.user.id]
    );

    return res.json({
      success: true,
      data: {
        transactions: rows.map((r) => ({
          id:                 r.id,
          reference:          r.reference,
          type:               r.type,
          service:            r.service,
          direction:          r.direction,
          amount:             Number(r.amount),
          status:             r.status,
          description:        r.description,
          provider_reference: r.provider_reference,
          metadata:           r.metadata || {},
          created_at:         r.created_at,
          updated_at:         r.created_at,
          source:             r.source,
        })),
        total: cnt[0]?.total || 0,
        limit,
        offset,
        filter,
      },
    });
  } catch (err) {
    console.error('[wallet] getTransactions:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transactions.' });
  }
}

/* ============================================================
   GET /wallet/recent-recipients
   ============================================================ */
export async function getRecentRecipients(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (metadata->>'phone')
              metadata->>'phone'              AS phone,
              COALESCE(metadata->>'network', '')       AS network,
              COALESCE(metadata->>'network_name', '')  AS network_name,
              created_at
         FROM transactions
        WHERE user_id = $1
          AND type = 'VTU'
          AND metadata->>'phone' IS NOT NULL
        ORDER BY metadata->>'phone', created_at DESC
        LIMIT 20`,
      [req.user.id]
    );

    const sorted = rows
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8);

    return res.json({
      success: true,
      data: {
        recipients: sorted.map((r) => ({
          phone:     r.phone,
          network:   r.network,
          last_used: r.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('[wallet] getRecentRecipients:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch recipients.' });
  }
}

/* ============================================================
   POST /wallet/topup  — DEV ONLY
   Directly credits the wallet.
   ============================================================ */
export async function topup(req, res) {
  try {
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!amount || amount <= 0 || amount > 1_000_000) {
      return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }

    const result = await creditWallet({
      userId:      req.user.id,
      amount,
      type:        'WALLET_TOPUP',
      description: 'Wallet top-up (dev)',
    });

    return res.json({
      success: true,
      message: 'Wallet topped up successfully.',
      data: {
        reference:      result.reference,
        amount:         result.amount,
        balance_before: result.before,
        balance_after:  result.after,
        idempotent:     !!result.idempotent,
      },
    });
  } catch (err) {
    console.error('[wallet] topup:', err);
    return res.status(500).json({ success: false, message: err.message || 'Top-up failed.' });
  }
}

/* ════════════════════════════════════════════════════════════
   FUND WALLET DEPOSIT FLOW
   ════════════════════════════════════════════════════════════ */

/* ============================================================
   POST /wallet/deposit
   Creates a PENDING deposit. No money moves until admin approves.
   ============================================================ */
export async function createDeposit(req, res) {
  try {
    const amount = Number(req.body?.amount);
    const paymentMethod = String(req.body?.payment_method || 'bank_transfer').toLowerCase();

    /* ── Validation ─────────────────────────────────────────── */
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ success: false, message: 'Enter a valid amount' });
    }
    if (amount < MIN_DEPOSIT) {
      return res.status(422).json({
        success: false,
        message: `Minimum deposit is ₦${MIN_DEPOSIT.toLocaleString()}`,
      });
    }
    if (amount > MAX_DEPOSIT) {
      return res.status(422).json({
        success: false,
        message: `Maximum deposit is ₦${MAX_DEPOSIT.toLocaleString()}`,
      });
    }
    if (!['bank_transfer', 'paystack', 'flutterwave'].includes(paymentMethod)) {
      return res.status(422).json({ success: false, message: 'Unsupported payment method' });
    }

    /* ── Ensure wallet exists ───────────────────────────────── */
    const wallet = await ensureWallet(req.user.id);
    if (!wallet) {
      return res.status(500).json({ success: false, message: 'Could not prepare wallet.' });
    }

    /* ── Use ledger's last settled balance_after as baseline ── */
    const { rows: lastLedger } = await query(
      `SELECT balance_after
         FROM wallet_ledger
        WHERE wallet_id = $1
          AND LOWER(COALESCE(status, 'successful')) NOT IN ('pending', 'processing')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [wallet.id]
    );
    const baseline = lastLedger[0]
      ? Number(lastLedger[0].balance_after)
      : Number(wallet.balance || 0);

    /* ── Insert the pending deposit ─────────────────────────── */
    const reference = generateDepositRef();

    const { rows } = await query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, type, direction, amount,
          balance_before, balance_after,
          reference, description, status, created_at, updated_at)
       VALUES ($1, $2, 'DEPOSIT', 'CREDIT', $3, $4, $4,
               $5, $6, 'pending', NOW(), NOW())
       RETURNING id, reference, amount, status, created_at`,
      [
        wallet.id,
        req.user.id,
        amount,
        baseline,
        reference,
        `Wallet deposit — ${paymentMethod}`,
      ]
    );

    const deposit = rows[0];

    return res.status(201).json({
      success: true,
      data: {
        id:                 deposit.id,
        deposit_id:         deposit.id,
        reference:          deposit.reference,
        amount:             Number(deposit.amount),
        status:             'pending',
        created_at:         deposit.created_at,
        payment_account:    PAYMENT_ACCOUNT,
        expires_in_seconds: 1800,
      },
    });
  } catch (err) {
    console.error('[wallet] createDeposit:', err);
    const isSchemaError = err.code === '42703' || err.code === '42P01';
    const isLedgerBreak = err.code === 'P0001' && /LEDGER_BREAK/.test(err.message || '');
    return res.status(500).json({
      success: false,
      message: isLedgerBreak
        ? 'Wallet ledger is out of sync. Please contact support.'
        : isSchemaError
          ? 'Database schema is out of date. Run the wallet_ledger migration.'
          : (err.message || 'Could not create deposit.'),
      code: err.code,
    });
  }
}

/* ============================================================
   GET /wallet/deposit/:id/status
   Polled by fund-wallet.js every 5 seconds.
   The DEPOSIT row's status flips to 'successful' when admin approves
   or 'rejected' when admin rejects.
   ============================================================ */
export async function getDepositStatus(req, res) {
  try {
    const { rows } = await query(
      `SELECT id, reference, amount,
              COALESCE(status, 'pending') AS status,
              description, created_at, updated_at
         FROM wallet_ledger
        WHERE id = $1
          AND user_id = $2
          AND type = 'DEPOSIT'
        LIMIT 1`,
      [req.params.id, req.user.id]
    );

    const deposit = rows[0];
    if (!deposit) {
      return res.status(404).json({ success: false, message: 'Deposit not found' });
    }

    return res.json({
      success: true,
      data: {
        id:          deposit.id,
        reference:   deposit.reference,
        amount:      Number(deposit.amount),
        status:      normalizeDepositStatus(deposit.status),
        description: deposit.description,
        created_at:  deposit.created_at,
        updated_at:  deposit.updated_at || deposit.created_at,
      },
    });
  } catch (err) {
    console.error('[wallet] getDepositStatus:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch deposit status.' });
  }
}