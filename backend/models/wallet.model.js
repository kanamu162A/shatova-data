// models/walletModel.js
// ============================================================
// Wallet model — matching the real wallet_ledger schema:
//   id, wallet_id, user_id, transaction_id, reference, type,
//   direction, amount, balance_before, balance_after,
//   description, created_at
// ============================================================

import { query, withTransaction } from '../config/database.js';

const Wallet = {
  /* ═══════════════════════════════════════════════════════════
     WALLET LOOKUP
     ═══════════════════════════════════════════════════════════ */
  async getWalletByUserId(userId, client = null) {
    const run = client ? client.query.bind(client) : query;
    const { rows } = await run(
      `SELECT id, user_id, balance, held_balance, status,
              daily_limit, daily_spent, created_at, updated_at
         FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  },

  /* ═══════════════════════════════════════════════════════════
     LEDGER LISTING
     ═══════════════════════════════════════════════════════════ */
  async listLedger({
    types = [], search = '', limit = 200, offset = 0, order = 'DESC',
  } = {}) {
    const params = [];
    const where = [];

    if (types.length) {
      params.push(types);
      where.push(`l.type = ANY($${params.length}::text[])`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        u.name  ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR l.reference ILIKE $${params.length}
        OR l.description ILIKE $${params.length}
      )`);
    }

    params.push(limit, offset);
    const dir = order === 'ASC' ? 'ASC' : 'DESC';

    const { rows } = await query(
      `SELECT
         l.id, l.user_id, l.wallet_id, l.transaction_id,
         u.name  AS user_name,
         u.email AS user_email,
         l.type, l.direction, l.amount,
         l.balance_before, l.balance_after,
         l.reference, l.description, l.created_at
       FROM wallet_ledger l
       LEFT JOIN users u ON u.id = l.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY l.created_at ${dir}, l.id ${dir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return rows.map(r => ({
      ...r,
      amount:         Number(r.amount || 0),
      balance_before: Number(r.balance_before || 0),
      balance_after:  Number(r.balance_after  || 0),
    }));
  },

  listDeposits(opts = {}) {
    return this.listLedger({ ...opts, types: ['DEPOSIT', 'WALLET_TOPUP', 'TOPUP', 'FUNDING'] });
  },

  listWithdrawals(opts = {}) {
    return this.listLedger({ ...opts, types: ['WITHDRAWAL', 'PAYOUT', 'WITHDRAW'] });
  },

  async findLedgerEntryById(id, client = null) {
    const run = client ? client.query.bind(client) : query;
    const { rows } = await run(
      `SELECT * FROM wallet_ledger WHERE id = $1::int LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  /* ═══════════════════════════════════════════════════════════
     STATS — Overview cards
     ═══════════════════════════════════════════════════════════ */
  async stats() {
    const { rows } = await query(`
      SELECT
        /* Deposits = WALLET_TOPUP / FUNDING credits (approved) */
        COALESCE(SUM(amount) FILTER (
          WHERE direction = 'CREDIT'
            AND type IN ('DEPOSIT','WALLET_TOPUP','TOPUP','FUNDING')
        ), 0)::numeric AS deposit_total,
        COUNT(*) FILTER (
          WHERE direction = 'CREDIT'
            AND type IN ('DEPOSIT','WALLET_TOPUP','TOPUP','FUNDING')
        )::int AS deposit_count,

        /* Withdrawals = DEBIT rows of type withdrawal/payout */
        COALESCE(SUM(amount) FILTER (
          WHERE direction = 'DEBIT'
            AND type IN ('WITHDRAWAL','PAYOUT','WITHDRAW')
        ), 0)::numeric AS withdrawal_total,
        COUNT(*) FILTER (
          WHERE direction = 'DEBIT'
            AND type IN ('WITHDRAWAL','PAYOUT','WITHDRAW')
        )::int AS withdrawal_count,

        /* Pending deposits = DEPOSIT rows with no matching approved topup */
        COUNT(*) FILTER (
          WHERE type = 'DEPOSIT'
            AND NOT EXISTS (
              SELECT 1 FROM wallet_ledger l2
               WHERE l2.user_id = l2.user_id
                 AND l2.reference = wallet_ledger.reference
                 AND l2.type IN ('WALLET_TOPUP','TOPUP','FUNDING')
            )
        )::int AS pending_deposits,

        0::int AS pending_withdrawals,

        COUNT(*) FILTER (WHERE type = 'DEPOSIT')::int AS all_deposits,
        COUNT(*) FILTER (
          WHERE type IN ('WITHDRAWAL','PAYOUT','WITHDRAW')
        )::int AS all_withdrawals
      FROM wallet_ledger
    `);
    return rows[0];
  },

  /* ═══════════════════════════════════════════════════════════
     DEPOSITS — user-facing (fund-wallet page)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Create a pending deposit. Inserts a DEPOSIT row in the ledger.
   * Wallet balance is untouched until admin approves.
   */
  async createDeposit({ userId, amount, reference }) {
    return withTransaction(async (client) => {
      const wallet = await this.getWalletByUserId(userId, client);
      if (!wallet) {
        throw Object.assign(new Error('Wallet not found'), { statusCode: 404, code: 'NO_WALLET' });
      }

      const amt = Number(amount);
      if (!(amt > 0)) {
        throw Object.assign(new Error('Invalid amount'), { statusCode: 422, code: 'BAD_AMOUNT' });
      }

      const { rows } = await client.query(
        `INSERT INTO wallet_ledger
           (wallet_id, user_id, type, direction, amount,
            balance_before, balance_after,
            reference, description, created_at)
         VALUES ($1, $2, 'DEPOSIT', 'CREDIT', $3, $4, $4, $5, $6, NOW())
         RETURNING id, reference, amount, created_at`,
        [
          wallet.id,
          userId,
          amt,
          Number(wallet.balance || 0),
          reference,
          'Wallet deposit — bank transfer',
        ]
      );

      return rows[0];
    });
  },

  /** Fetch a deposit scoped to the owner (no cross-user leakage). */
  async getDepositForUser(depositId, userId) {
    const { rows } = await query(
      `SELECT id, reference, amount, description, created_at
         FROM wallet_ledger
        WHERE id = $1::int
          AND user_id = $2::int
          AND type = 'DEPOSIT'
        LIMIT 1`,
      [depositId, userId]
    );
    return rows[0] || null;
  },

  /**
   * Check if a deposit has been approved.
   * Approval = a WALLET_TOPUP row exists for the same user + reference.
   * Returns: 'successful' | 'pending'
   */
  async getDepositApprovalStatus(depositId, userId) {
    const { rows } = await query(
      `SELECT
         l.id, l.reference, l.amount, l.description, l.created_at,
         EXISTS (
           SELECT 1 FROM wallet_ledger l2
            WHERE l2.user_id = l.user_id
              AND l2.reference = l.reference
              AND l2.type IN ('WALLET_TOPUP','TOPUP','FUNDING')
         ) AS approved
       FROM wallet_ledger l
       WHERE l.id = $1::int
         AND l.user_id = $2::int
         AND l.type = 'DEPOSIT'
       LIMIT 1`,
      [depositId, userId]
    );
    return rows[0] || null;
  },

  /** Mark a deposit as failed — inserts a DEBIT offset row. */
  async failDeposit(depositId, reason = null) {
    return withTransaction(async (client) => {
      const { rows: depRows } = await client.query(
        `SELECT id, wallet_id, user_id, reference, amount
           FROM wallet_ledger
          WHERE id = $1::int AND type = 'DEPOSIT'
          LIMIT 1
          FOR UPDATE`,
        [depositId]
      );
      const dep = depRows[0];
      if (!dep) return null;

      /* Offset the pending DEPOSIT with a DEBIT so it doesn't linger */
      const { rows } = await client.query(
        `INSERT INTO wallet_ledger
           (wallet_id, user_id, type, direction, amount,
            balance_before, balance_after,
            reference, description, created_at)
         VALUES ($1, $2, 'DEPOSIT_REVERSAL', 'DEBIT', $3, $4, $4, $5, $6, NOW())
         RETURNING id, reference, amount, created_at`,
        [
          dep.wallet_id,
          dep.user_id,
          Number(dep.amount),
          0,
          `REV-${dep.reference}`,
          `Deposit rejected — ${reason || 'no reason given'}`,
        ]
      );

      return { ...rows[0], status: 'failed', reason };
    });
  },

  /* ═══════════════════════════════════════════════════════════
     WITHDRAWALS
     ═══════════════════════════════════════════════════════════ */

  async createWithdrawalRequest({ userId, amount, bank, reference }) {
    return withTransaction(async (client) => {
      const wallet = await this.getWalletByUserId(userId, client);
      if (!wallet) {
        throw Object.assign(new Error('Wallet not found'), { statusCode: 404, code: 'NO_WALLET' });
      }

      const amt = Number(amount);
      const balanceBefore = Number(wallet.balance || 0);
      if (balanceBefore < amt) {
        throw Object.assign(new Error('Insufficient balance'), { statusCode: 422, code: 'INSUFFICIENT' });
      }
      const balanceAfter = balanceBefore - amt;

      await client.query(
        `UPDATE wallets SET balance = $2, updated_at = NOW() WHERE id = $1`,
        [wallet.id, balanceAfter]
      );

      const { rows } = await client.query(
        `INSERT INTO wallet_ledger
           (wallet_id, user_id, type, direction, amount,
            balance_before, balance_after,
            reference, description, created_at)
         VALUES ($1, $2, 'WITHDRAWAL', 'DEBIT', $3, $4, $5, $6, $7, NOW())
         RETURNING id, reference, amount, created_at`,
        [
          wallet.id,
          userId,
          amt,
          balanceBefore,
          balanceAfter,
          reference,
          `Withdrawal to ${bank.bank_name} ${bank.account_number}`,
        ]
      );

      return { ...rows[0], status: 'pending' };
    });
  },

  async settleWithdrawal(withdrawalId, adminId, action, payload = {}) {
    const isApprove = action === 'approve';

    return withTransaction(async (client) => {
      const { rows: ledgerRows } = await client.query(
        `SELECT * FROM wallet_ledger
          WHERE id = $1::int AND type IN ('WITHDRAWAL','PAYOUT','WITHDRAW')
          LIMIT 1 FOR UPDATE`,
        [withdrawalId]
      );
      const entry = ledgerRows[0];
      if (!entry) {
        throw Object.assign(new Error('Withdrawal not found'), { statusCode: 404, code: 'NOT_FOUND' });
      }

      /* Reject → refund */
      if (!isApprove) {
        const reason        = payload.reason;
        const amount        = Number(entry.amount || 0);
        const balanceBefore = Number(entry.balance_after || 0);
        const balanceAfter  = balanceBefore + amount;

        const { rows: wRows } = await client.query(
          `SELECT balance FROM wallets WHERE id = $1 FOR UPDATE`,
          [entry.wallet_id]
        );
        const currentBalance = Number(wRows[0]?.balance || 0);
        const refundAfter    = currentBalance + amount;

        await client.query(
          `UPDATE wallets SET balance = $2, updated_at = NOW() WHERE id = $1`,
          [entry.wallet_id, refundAfter]
        );

        const { rows } = await client.query(
          `INSERT INTO wallet_ledger
             (wallet_id, user_id, type, direction, amount,
              balance_before, balance_after,
              reference, description, created_at)
           VALUES ($1, $2, 'REFUND', 'CREDIT', $3, $4, $5, $6, $7, NOW())
           RETURNING id, reference, amount, created_at`,
          [
            entry.wallet_id,
            entry.user_id,
            amount,
            currentBalance,
            refundAfter,
            `REF-${entry.reference}`,
            `Withdrawal refund — ${reason || 'rejected by admin'}`,
          ]
        );

        return { ...rows[0], status: 'rejected', refunded: true, refund_amount: amount };
      }

      /* Approve → no ledger change; funds already debited at request time */
      return { ...entry, status: 'successful' };
    });
  },

  approveWithdrawal(id, adminId, payload) { return this.settleWithdrawal(id, adminId, 'approve', payload); },
  rejectWithdrawal(id, adminId, payload)  { return this.settleWithdrawal(id, adminId, 'reject',  payload); },
};

export default Wallet;