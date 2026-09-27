// controllers/walletAdmin.controller.js
// ============================================================
// Admin wallet operations — deposits, withdrawals, approvals
// ============================================================
// Data model notes (based on actual DB inspection):
//   - Deposits may live in `wallet_ledger` (pending review) with
//     type 'DEPOSIT' / 'WALLET_TOPUP' / 'TOPUP' / 'FUNDING' / 'CREDIT'
//   - Approved deposits are ALSO written to `transactions` with
//     type 'WALLET_TOPUP' + direction 'CREDIT'
//   - Withdrawals: wallet_ledger ('WITHDRAWAL','PAYOUT','WITHDRAW',
//     'WALLET_WITHDRAWAL') and mirrored in transactions
//     ('WALLET_WITHDRAWAL', ...) with direction 'DEBIT'
//   - Status is stored UPPERCASE ('SUCCESS','PENDING') — we
//     lowercase it before returning so the frontend matches.
// ============================================================

import { query } from '../config/database.js';
import { creditWallet } from '../services/wallet.service.js';

/* ============================================================
   SHARED CONSTANTS + HELPERS
   ============================================================ */

const DEPOSIT_LEDGER_TYPES  = ['DEPOSIT', 'WALLET_TOPUP', 'TOPUP', 'FUNDING', 'CREDIT'];
const DEPOSIT_TXN_TYPES     = ['WALLET_TOPUP', 'DEPOSIT', 'TOPUP', 'FUNDING'];

const WITHDRAWAL_LEDGER_TYPES = ['WITHDRAWAL', 'PAYOUT', 'WITHDRAW', 'WALLET_WITHDRAWAL'];
const WITHDRAWAL_TXN_TYPES    = ['WALLET_WITHDRAWAL', 'WITHDRAWAL', 'PAYOUT', 'WITHDRAW'];

const lower = (s) => String(s || '').toLowerCase();

function shapeDeposit(r) {
  return {
    ...r,
    amount:         Number(r.amount || 0),
    balance_before: Number(r.balance_before || 0),
    balance_after:  Number(r.balance_after  || 0),
    status:         lower(r.status || 'pending'),
    bank_name:      r.metadata?.bank_name      || 'Moniepoint MFB',
    account_number: r.metadata?.account_number || '6034037129',
    account_name:   r.metadata?.account_name   || 'Umar Mannir Abubakar',
  };
}

function shapeWithdrawal(r) {
  return {
    ...r,
    amount:         Number(r.amount || 0),
    balance_before: Number(r.balance_before || 0),
    balance_after:  Number(r.balance_after  || 0),
    status:         lower(r.status || 'pending'),
    bank_name:      r.metadata?.bank_name      || 'Moniepoint MFB',
    account_number: r.metadata?.account_number || '6034037129',
    account_name:   r.metadata?.account_name   || 'Umar Mannir Abubakar',
  };
}

/* ============================================================
   DEPOSITS — LIST
   GET /wallet/admin/deposits/all
   ============================================================ */
export async function getDeposits(req, res) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 500, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = String(req.query.search || '').trim();

    const params = [DEPOSIT_LEDGER_TYPES, DEPOSIT_TXN_TYPES];

    const ledgerSql = `
      SELECT
        l.id,
        l.user_id,
        l.wallet_id,
        l.reference,
        l.type,
        l.direction,
        l.amount,
        l.balance_before,
        l.balance_after,
        l.description,
        l.created_at,
        l.updated_at,
        UPPER(COALESCE(l.status, 'PENDING')) AS status,
        l.metadata,
        u.name  AS user_name,
        u.email AS user_email,
        'wallet_ledger'::text AS _source
      FROM wallet_ledger l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE UPPER(l.type) = ANY($1::text[])
    `;

    const txnSql = `
      SELECT
        t.id,
        t.user_id,
        NULL::int AS wallet_id,
        t.reference,
        t.type,
        t.direction,
        t.amount,
        NULL::numeric AS balance_before,
        NULL::numeric AS balance_after,
        t.description,
        t.created_at,
        t.updated_at,
        UPPER(COALESCE(t.status, 'PENDING')) AS status,
        t.metadata,
        u.name  AS user_name,
        u.email AS user_email,
        'transactions'::text AS _source
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      WHERE UPPER(t.type) = ANY($2::text[])
        AND UPPER(COALESCE(t.direction, 'CREDIT')) = 'CREDIT'
    `;

    let searchClause = '';
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      searchClause = `AND (user_name ILIKE $${i} OR user_email ILIKE $${i} OR reference ILIKE $${i})`;
    }

    params.push(limit, offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      WITH combined AS (
        ${ledgerSql}
        UNION ALL
        ${txnSql}
      ),
      ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY reference
                 ORDER BY (CASE WHEN _source = 'wallet_ledger' THEN 0 ELSE 1 END),
                          created_at DESC
               ) AS rn
          FROM combined
      )
      SELECT *
        FROM ranked
       WHERE rn = 1
       ${searchClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await query(sql, params);

    return res.json({
      success: true,
      data: rows.map(shapeDeposit),
      meta: { count: rows.length, limit, offset },
    });
  } catch (err) {
    console.error('[walletAdmin] getDeposits:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch deposits.' });
  }
}

/* ============================================================
   DEPOSIT — SINGLE
   GET /wallet/admin/deposit/:id
   ============================================================ */
export async function getDeposit(req, res) {
  try {
    let { rows } = await query(
      `SELECT l.*, u.name AS user_name, u.email AS user_email
         FROM wallet_ledger l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!rows[0]) {
      ({ rows } = await query(
        `SELECT t.*, u.name AS user_name, u.email AS user_email
           FROM transactions t
           LEFT JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 LIMIT 1`,
        [req.params.id]
      ));
    }

    if (!rows[0]) return res.status(404).json({ success: false, message: 'Deposit not found' });
    return res.json({ success: true, data: shapeDeposit(rows[0]) });
  } catch (err) {
    console.error('[walletAdmin] getDeposit:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch deposit.' });
  }
}

/* ============================================================
   DEPOSIT — APPROVE
   POST /wallet/admin/deposit/:id/approve
   ============================================================ */
export async function approveDeposit(req, res) {
  const { transaction_reference, approval_notes } = req.body || {};
  const bankRef = String(transaction_reference || '').trim();

  if (!bankRef)           return res.status(422).json({ success: false, message: 'Bank reference is required' });
  if (bankRef.length < 4) return res.status(422).json({ success: false, message: 'Reference too short' });

  try {
    /* ---- wallet_ledger path ---- */
    const { rows: claimed } = await query(
      `UPDATE wallet_ledger
          SET status     = 'processing',
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'claimed_at', NOW()::text,
                                 'claimed_by', $2::text,
                                 'bank_ref',   $3::text
                               ),
              updated_at = NOW()
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND LOWER(COALESCE(status, 'pending')) = 'pending'
        RETURNING id, user_id, wallet_id, amount, reference`,
      [req.params.id, req.user.id, bankRef, DEPOSIT_LEDGER_TYPES]
    );

    const dep = claimed[0];

    if (dep) {
      const result = await creditWallet({
        userId:      dep.user_id,
        amount:      Number(dep.amount),
        reference:   dep.reference,
        type:        'WALLET_TOPUP',
        description: approval_notes || `Deposit approved — bank ref ${bankRef}`,
      });

      await query(
        `UPDATE wallet_ledger
            SET status        = 'successful',
                balance_after = $2,
                metadata      = COALESCE(metadata, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'approved_at',     NOW()::text,
                                      'approved_by',     $3::text,
                                      'bank_reference',  $4::text,
                                      'topup_reference', $4::text
                                    ),
                updated_at    = NOW()
          WHERE id = $1`,
        [dep.id, result.after, req.user.id, dep.reference]
      );

      await query(
        `INSERT INTO money_audit_log
           (event_type, user_id, wallet_id, reference, amount,
            balance_before, balance_after, actor, source, details)
         VALUES ('deposit_approved', $1, $2, $3, $4, $5, $6, $7, 'admin', $8::jsonb)`,
        [
          dep.user_id, dep.wallet_id, dep.reference, Number(dep.amount),
          result.before, result.after,
          String(req.user.id),
          JSON.stringify({ bank_reference: bankRef, notes: approval_notes }),
        ]
      );

      return res.json({
        success: true,
        message: 'Deposit approved and wallet credited',
        data: {
          deposit: {
            id:            dep.id,
            reference:     dep.reference,
            amount:        Number(dep.amount),
            status:        'successful',
            balance_after: result.after,
            updated_at:    new Date().toISOString(),
          },
        },
      });
    }

    /* ---- transactions fallback ---- */
    const { rows: txnRows } = await query(
      `UPDATE transactions
          SET status     = 'SUCCESS',
              updated_at = NOW(),
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'approved_at', NOW()::text,
                                 'approved_by', $2::text,
                                 'bank_ref',    $3::text
                               )
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND UPPER(COALESCE(status, 'PENDING')) IN ('PENDING', 'PROCESSING')
        RETURNING id, user_id, amount, reference, status`,
      [req.params.id, req.user.id, bankRef, DEPOSIT_TXN_TYPES]
    );

    const txn = txnRows[0];
    if (!txn) {
      const { rows: existing } = await query(
        `SELECT status FROM wallet_ledger WHERE id = $1
         UNION ALL
         SELECT status FROM transactions WHERE id = $1
         LIMIT 1`,
        [req.params.id]
      );
      if (!existing[0]) return res.status(404).json({ success: false, message: 'Deposit not found' });
      return res.status(409).json({
        success: false,
        message: `Cannot approve — deposit is ${lower(existing[0].status)}`,
        code:    lower(existing[0].status) === 'successful' ? 'ALREADY_APPROVED' : 'IN_FLIGHT',
      });
    }

    return res.json({
      success: true,
      message: 'Deposit approved',
      data: {
        deposit: {
          id:         txn.id,
          reference:  txn.reference,
          amount:     Number(txn.amount),
          status:     'successful',
          updated_at: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    console.error('[walletAdmin] approveDeposit:', err);

    try {
      await query(
        `UPDATE wallet_ledger SET status = 'pending', updated_at = NOW()
          WHERE id = $1 AND status = 'processing'`,
        [req.params.id]
      );
    } catch (_) { /* ignore */ }

    return res.status(500).json({ success: false, message: err.message || 'Approval failed' });
  }
}

/* ============================================================
   DEPOSIT — REJECT
   POST /wallet/admin/deposit/:id/reject
   ============================================================ */
export async function rejectDeposit(req, res) {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(422).json({ success: false, message: 'Reason (min 5 chars) required' });

  try {
    const { rows: claimed } = await query(
      `UPDATE wallet_ledger
          SET status     = 'rejected',
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'rejected_at', NOW()::text,
                                 'rejected_by', $2::text,
                                 'reason',      $3::text
                               ),
              updated_at = NOW()
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND LOWER(COALESCE(status, 'pending')) = 'pending'
        RETURNING id, user_id, wallet_id, amount, reference`,
      [req.params.id, req.user.id, reason, DEPOSIT_LEDGER_TYPES]
    );

    const dep = claimed[0];
    if (dep) {
      await query(
        `INSERT INTO money_audit_log
           (event_type, user_id, wallet_id, reference, amount, actor, source, details)
         VALUES ('deposit_rejected', $1, $2, $3, $4, $5, 'admin', $6::jsonb)`,
        [dep.user_id, dep.wallet_id, dep.reference, Number(dep.amount), String(req.user.id), JSON.stringify({ reason })]
      );

      return res.json({
        success: true,
        message: 'Deposit rejected',
        data: { deposit: { id: dep.id, reference: dep.reference, amount: Number(dep.amount), status: 'rejected', reason } },
      });
    }

    /* Fallback: transactions */
    const { rows: txnRows } = await query(
      `UPDATE transactions
          SET status     = 'FAILED',
              updated_at = NOW(),
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'rejected_at', NOW()::text,
                                 'rejected_by', $2::text,
                                 'reason',      $3::text
                               )
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND UPPER(COALESCE(status, 'PENDING')) IN ('PENDING', 'PROCESSING')
        RETURNING id, user_id, amount, reference`,
      [req.params.id, req.user.id, reason, DEPOSIT_TXN_TYPES]
    );

    if (!txnRows[0]) {
      return res.status(409).json({ success: false, message: 'Deposit already settled or not found' });
    }

    return res.json({
      success: true,
      message: 'Deposit rejected',
      data: { deposit: { id: txnRows[0].id, reference: txnRows[0].reference, amount: Number(txnRows[0].amount), status: 'rejected', reason } },
    });
  } catch (err) {
    console.error('[walletAdmin] rejectDeposit:', err);
    return res.status(500).json({ success: false, message: 'Rejection failed.' });
  }
}

/* ============================================================
   WITHDRAWALS — LIST
   GET /wallet/admin/withdrawals/all
   ============================================================ */
export async function getWithdrawals(req, res) {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 500, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = String(req.query.search || '').trim();

    const params = [WITHDRAWAL_LEDGER_TYPES, WITHDRAWAL_TXN_TYPES];

    const ledgerSql = `
      SELECT
        l.id, l.user_id, l.wallet_id, l.reference,
        l.type, l.direction, l.amount,
        l.balance_before, l.balance_after,
        l.description, l.created_at, l.updated_at,
        UPPER(COALESCE(l.status, 'PENDING')) AS status,
        l.metadata,
        u.name  AS user_name, u.email AS user_email,
        'wallet_ledger'::text AS _source
      FROM wallet_ledger l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE UPPER(l.type) = ANY($1::text[])
    `;

    const txnSql = `
      SELECT
        t.id, t.user_id, NULL::int AS wallet_id, t.reference,
        t.type, t.direction, t.amount,
        NULL::numeric AS balance_before, NULL::numeric AS balance_after,
        t.description, t.created_at, t.updated_at,
        UPPER(COALESCE(t.status, 'PENDING')) AS status,
        t.metadata,
        u.name  AS user_name, u.email AS user_email,
        'transactions'::text AS _source
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      WHERE UPPER(t.type) = ANY($2::text[])
        AND UPPER(COALESCE(t.direction, 'DEBIT')) = 'DEBIT'
    `;

    let searchClause = '';
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      searchClause = `AND (user_name ILIKE $${i} OR user_email ILIKE $${i} OR reference ILIKE $${i})`;
    }

    params.push(limit, offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      WITH combined AS (
        ${ledgerSql}
        UNION ALL
        ${txnSql}
      ),
      ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY reference
                 ORDER BY (CASE WHEN _source = 'wallet_ledger' THEN 0 ELSE 1 END),
                          created_at DESC
               ) AS rn
          FROM combined
      )
      SELECT *
        FROM ranked
       WHERE rn = 1
       ${searchClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await query(sql, params);

    return res.json({
      success: true,
      data: rows.map(shapeWithdrawal),
      meta: { count: rows.length, limit, offset },
    });
  } catch (err) {
    console.error('[walletAdmin] getWithdrawals:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch withdrawals.' });
  }
}

/* ============================================================
   WITHDRAWAL — SINGLE
   GET /wallet/admin/withdrawal/:id
   ============================================================ */
export async function getWithdrawal(req, res) {
  try {
    let { rows } = await query(
      `SELECT l.*, u.name AS user_name, u.email AS user_email
         FROM wallet_ledger l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!rows[0]) {
      ({ rows } = await query(
        `SELECT t.*, u.name AS user_name, u.email AS user_email
           FROM transactions t
           LEFT JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 LIMIT 1`,
        [req.params.id]
      ));
    }

    if (!rows[0]) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    return res.json({ success: true, data: shapeWithdrawal(rows[0]) });
  } catch (err) {
    console.error('[walletAdmin] getWithdrawal:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch withdrawal.' });
  }
}

/* ============================================================
   WITHDRAWAL — APPROVE
   POST /wallet/admin/withdrawal/:id/approve
   ============================================================ */
export async function approveWithdrawal(req, res) {
  const ref = String(req.body?.transaction_reference || '').trim();
  if (!ref) return res.status(422).json({ success: false, message: 'Transaction reference required' });

  try {
    const { rows: claimed } = await query(
      `UPDATE wallet_ledger
          SET status     = 'successful',
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'approved_at',    NOW()::text,
                                 'approved_by',    $2::text,
                                 'bank_reference', $3::text
                               ),
              updated_at = NOW()
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND LOWER(COALESCE(status, 'pending')) = 'pending'
        RETURNING id, user_id, reference, amount`,
      [req.params.id, req.user.id, ref, WITHDRAWAL_LEDGER_TYPES]
    );

    const w = claimed[0];
    if (w) {
      await query(
        `INSERT INTO money_audit_log
           (event_type, user_id, reference, amount, actor, source, details)
         VALUES ('debit', $1, $2, $3, $4, 'admin', $5::jsonb)`,
        [w.user_id, w.reference, Number(w.amount), String(req.user.id), JSON.stringify({ action: 'withdrawal_approved', bank_reference: ref })]
      );

      return res.json({
        success: true,
        message: 'Withdrawal approved',
        data: { withdrawal: { id: w.id, status: 'successful', reference: ref } },
      });
    }

    /* Fallback: transactions */
    const { rows: txnRows } = await query(
      `UPDATE transactions
          SET status     = 'SUCCESS',
              updated_at = NOW(),
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'approved_at',    NOW()::text,
                                 'approved_by',    $2::text,
                                 'bank_reference', $3::text
                               )
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND UPPER(COALESCE(status, 'PENDING')) IN ('PENDING', 'PROCESSING')
        RETURNING id, user_id, reference, amount`,
      [req.params.id, req.user.id, ref, WITHDRAWAL_TXN_TYPES]
    );

    if (!txnRows[0]) {
      return res.status(409).json({ success: false, message: 'Already settled or not found' });
    }

    return res.json({
      success: true,
      message: 'Withdrawal approved',
      data: { withdrawal: { id: txnRows[0].id, status: 'successful', reference: ref } },
    });
  } catch (err) {
    console.error('[walletAdmin] approveWithdrawal:', err);
    return res.status(500).json({ success: false, message: 'Approval failed.' });
  }
}

/* ============================================================
   WITHDRAWAL — REJECT
   POST /wallet/admin/withdrawal/:id/reject
   Refunds the held amount back to the user's wallet.
   ============================================================ */
export async function rejectWithdrawal(req, res) {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(422).json({ success: false, message: 'Reason (min 5 chars) required' });

  try {
    const { rows: claimed } = await query(
      `UPDATE wallet_ledger
          SET status     = 'rejected',
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'rejected_at', NOW()::text,
                                 'rejected_by', $2::text,
                                 'reason',      $3::text
                               ),
              updated_at = NOW()
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND LOWER(COALESCE(status, 'pending')) = 'pending'
        RETURNING id, user_id, wallet_id, reference, amount`,
      [req.params.id, req.user.id, reason, WITHDRAWAL_LEDGER_TYPES]
    );

    const w = claimed[0];
    if (w) {
      /* Return the held funds */
      try {
        await creditWallet({
          userId:      w.user_id,
          amount:      Number(w.amount),
          reference:   `REVERSAL-${w.reference}`,
          type:        'WALLET_REFUND',
          description: `Withdrawal rejected — ${reason}`,
        });
      } catch (creditErr) {
        console.error('[walletAdmin] refund after reject failed:', creditErr);
      }

      await query(
        `INSERT INTO money_audit_log
           (event_type, user_id, reference, amount, actor, source, details)
         VALUES ('refund', $1, $2, $3, $4, 'admin', $5::jsonb)`,
        [w.user_id, w.reference, Number(w.amount), String(req.user.id), JSON.stringify({ action: 'withdrawal_rejected', reason })]
      );

      return res.json({
        success: true,
        message: 'Withdrawal rejected and funds returned',
        data: { withdrawal: { id: w.id, status: 'rejected', reason } },
      });
    }

    /* Fallback: transactions */
    const { rows: txnRows } = await query(
      `UPDATE transactions
          SET status     = 'FAILED',
              updated_at = NOW(),
              metadata   = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object(
                                 'rejected_at', NOW()::text,
                                 'rejected_by', $2::text,
                                 'reason',      $3::text
                               )
        WHERE id = $1
          AND UPPER(type) = ANY($4::text[])
          AND UPPER(COALESCE(status, 'PENDING')) IN ('PENDING', 'PROCESSING')
        RETURNING id, user_id, amount, reference`,
      [req.params.id, req.user.id, reason, WITHDRAWAL_TXN_TYPES]
    );

    if (!txnRows[0]) {
      return res.status(409).json({ success: false, message: 'Already settled or not found' });
    }

    /* Refund wallet */
    try {
      await creditWallet({
        userId:      txnRows[0].user_id,
        amount:      Number(txnRows[0].amount),
        reference:   `REVERSAL-${txnRows[0].reference}`,
        type:        'WALLET_REFUND',
        description: `Withdrawal rejected — ${reason}`,
      });
    } catch (creditErr) {
      console.error('[walletAdmin] refund after reject failed:', creditErr);
    }

    return res.json({
      success: true,
      message: 'Withdrawal rejected and funds returned',
      data: { withdrawal: { id: txnRows[0].id, status: 'rejected', reason } },
    });
  } catch (err) {
    console.error('[walletAdmin] rejectWithdrawal:', err);
    return res.status(500).json({ success: false, message: 'Rejection failed.' });
  }
}