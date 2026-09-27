// services/admin.service.js
// ============================================================
// Admin service — user lookup, manual fund/debit, drift, mismatches
//
// 🔑 WALLET DRIFT DEFINITION (corrected):
//    A wallet is "in sync" when:
//        wallets.balance === last wallet_ledger.balance_after
//    Holds (wallets.held_balance + wallet_holds.status='HELD') are
//    money already removed from `balance` at hold time — they are
//    NOT subtracted again. The old `ledger - held` formula was wrong.
// ============================================================

import { query, withTransaction } from '../config/database.js';

/* ============================================================
   USER LOOKUP
   ============================================================ */
export async function findUser({ userId, email, phone } = {}) {
  const where = [];
  const params = [];

  if (userId) {
    params.push(userId);
    where.push(`id = $${params.length}`);
  }
  if (email) {
    params.push(String(email).toLowerCase().trim());
    where.push(`LOWER(email) = $${params.length}`);
  }
  if (phone) {
    const digits = String(phone).replace(/\D/g, '');
    params.push(digits);
    where.push(`REGEXP_REPLACE(COALESCE(phone,''), '\\D', '', 'g') = $${params.length}`);
  }

  if (!where.length) return null;

  const { rows } = await query(
    `SELECT id, name, email, phone, role, is_verified, is_active, created_at
       FROM users
      WHERE ${where.join(' OR ')}
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

/* ============================================================
   FULL USER DETAILS (with live wallet figures)
   ============================================================ */
export async function getUserFullDetails({ userId, email, phone } = {}) {
  const user = await findUser({ userId, email, phone });
  if (!user) return null;

  const { rows: wRows } = await query(
    `SELECT id, balance, held_balance, status, daily_limit, daily_spent
       FROM wallets WHERE user_id = $1 LIMIT 1`,
    [user.id]
  );
  const wallet = wRows[0] || { balance: 0, held_balance: 0 };

  const { rows: txRows } = await query(
    `SELECT COUNT(*)::int AS transaction_count
       FROM transactions WHERE user_id = $1`,
    [user.id]
  );

  const { rows: totals } = await query(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric AS total_funded,
        COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'),  0)::numeric AS total_spent
       FROM wallet_ledger WHERE user_id = $1`,
    [user.id]
  );

  return {
    ...user,
    balance: Number(wallet.balance || 0),
    held_balance: Number(wallet.held_balance || 0),
    wallet_status: wallet.status,
    daily_limit: Number(wallet.daily_limit || 0),
    daily_spent: Number(wallet.daily_spent || 0),
    transaction_count: txRows[0]?.transaction_count || 0,
    total_funded: Number(totals[0]?.total_funded || 0),
    total_spent: Number(totals[0]?.total_spent || 0),
  };
}

/* ============================================================
   MANUAL FUND
   ============================================================ */
export async function manualFund({ adminId, adminEmail, userId, amount, reason, source = 'support' }) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!amt || amt <= 0) throw new Error('Amount must be > 0.');

  return withTransaction(async (client) => {
    const { rows: w } = await client.query(
      `SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!w[0]) throw new Error('Wallet not found.');
    const wallet = w[0];

    const before = Number(wallet.balance || 0);
    const after  = Math.round((before + amt) * 100) / 100;

    await client.query(
      `UPDATE wallets
          SET balance = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2`,
      [after, wallet.id]
    );

    const reference = `ADMIN-FUND-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    await client.query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, reference, type, direction,
          amount, balance_before, balance_after, description,
          status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 'ADMIN_CREDIT', 'CREDIT',
               $4, $5, $6, $7,
               'successful', $8::jsonb, NOW(), NOW())`,
      [
        wallet.id, userId, reference, amt, before, after,
        `Manual fund — ${reason}`,
        JSON.stringify({ admin_id: adminId, admin_email: adminEmail, source, reason }),
      ]
    );

    await client.query(
      `INSERT INTO money_audit_log
         (event_type, user_id, wallet_id, reference, amount,
          balance_before, balance_after, actor, source, details)
       VALUES ('admin_credit', $1, $2, $3, $4, $5, $6, $7, 'admin', $8::jsonb)`,
      [
        userId, wallet.id, reference, amt, before, after,
        String(adminEmail || adminId),
        JSON.stringify({ reason, source }),
      ]
    ).catch(() => {});

    return {
      reference,
      amount: amt,
      wallet_before: before,
      wallet_after: after,
    };
  });
}

/* ============================================================
   MANUAL DEBIT
   ============================================================ */
export async function manualDebit({ adminId, adminEmail, userId, amount, reason, source = 'correction' }) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!amt || amt <= 0) throw new Error('Amount must be > 0.');

  return withTransaction(async (client) => {
    const { rows: w } = await client.query(
      `SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!w[0]) throw new Error('Wallet not found.');
    const wallet = w[0];

    const before = Number(wallet.balance || 0);
    if (before < amt) {
      const err = new Error('Insufficient balance.');
      err.code = 'INSUFFICIENT_BALANCE';
      err.data = { balance: before, required: amt };
      throw err;
    }
    const after = Math.round((before - amt) * 100) / 100;

    await client.query(
      `UPDATE wallets
          SET balance = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2`,
      [after, wallet.id]
    );

    const reference = `ADMIN-DEBIT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    await client.query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, reference, type, direction,
          amount, balance_before, balance_after, description,
          status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 'ADMIN_DEBIT', 'DEBIT',
               $4, $5, $6, $7,
               'successful', $8::jsonb, NOW(), NOW())`,
      [
        wallet.id, userId, reference, amt, before, after,
        `Manual debit — ${reason}`,
        JSON.stringify({ admin_id: adminId, admin_email: adminEmail, source, reason }),
      ]
    );

    await client.query(
      `INSERT INTO money_audit_log
         (event_type, user_id, wallet_id, reference, amount,
          balance_before, balance_after, actor, source, details)
       VALUES ('admin_debit', $1, $2, $3, $4, $5, $6, $7, 'admin', $8::jsonb)`,
      [
        userId, wallet.id, reference, amt, before, after,
        String(adminEmail || adminId),
        JSON.stringify({ reason, source }),
      ]
    ).catch(() => {});

    return {
      reference,
      amount: amt,
      wallet_before: before,
      wallet_after: after,
    };
  });
}

/* ============================================================
   WALLET DRIFT — corrected formula
   ------------------------------------------------------------
   A wallet is in sync when:
       wallets.balance === last wallet_ledger.balance_after
   (held_balance is money already removed from balance at hold
   time — do NOT subtract it again.)
   ============================================================ */
export async function listWalletDrift() {
  const { rows } = await query(`
    WITH last_ledger AS (
      SELECT DISTINCT ON (wallet_id)
             wallet_id, balance_after
        FROM wallet_ledger
       ORDER BY wallet_id, created_at DESC, id DESC
    ),
    holds AS (
      SELECT wallet_id, COALESCE(SUM(amount), 0) AS held_sum
        FROM wallet_holds
       WHERE status = 'HELD'
       GROUP BY wallet_id
    )
    SELECT
      w.id                                  AS wallet_id,
      w.user_id,
      u.email                               AS user_email,
      u.phone                               AS user_phone,
      w.balance                             AS wallet_balance,
      w.held_balance                        AS wallet_held,
      COALESCE(ll.balance_after, 0)         AS ledger_balance,
      COALESCE(h.held_sum, 0)               AS active_held_sum,
      COALESCE(ll.balance_after, 0)         AS expected_balance,
      (w.balance - COALESCE(ll.balance_after, 0)) AS drift
    FROM wallets w
    LEFT JOIN users        u  ON u.id = w.user_id
    LEFT JOIN last_ledger  ll ON ll.wallet_id = w.id
    LEFT JOIN holds        h  ON h.wallet_id = w.id
    WHERE w.balance IS DISTINCT FROM COALESCE(ll.balance_after, 0)
    ORDER BY ABS(w.balance - COALESCE(ll.balance_after, 0)) DESC
  `);
  return rows;
}

/* ============================================================
   DASHBOARD STATS
   ============================================================ */
export async function getDashboardStats() {
  const [
    { rows: uRows },
    { rows: tRows },
    { rows: dRows },
  ] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int                                                 AS total_users,
        COUNT(*) FILTER (WHERE role IN ('admin','super_admin','owner'))::int AS admin_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS new_users_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_users_30d,
        (SELECT COALESCE(SUM(balance), 0)::numeric FROM wallets)      AS total_balance,
        (SELECT COALESCE(SUM(held_balance), 0)::numeric FROM wallets) AS total_held
      FROM users
    `),
    query(`
      SELECT
        COUNT(*)::int                                                   AS total,
        COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')::int          AS successful,
        COUNT(*) FILTER (WHERE UPPER(status) = 'FAILED')::int           AS failed,
        COUNT(*) FILTER (WHERE UPPER(status) IN ('PENDING','PROCESSING'))::int AS pending,
        COALESCE(SUM(amount) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS volume,
        COALESCE(SUM(profit) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS profit
      FROM transactions
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE type ILIKE '%deposit%' OR type IN ('WALLET_TOPUP','TOPUP','FUNDING','ADMIN_CREDIT'))::int AS deposit_count,
        COUNT(*) FILTER (WHERE type ILIKE '%withdraw%' OR type = 'PAYOUT')::int AS withdrawal_count,
        COALESCE(SUM(amount) FILTER (WHERE type ILIKE '%deposit%' OR type IN ('WALLET_TOPUP','TOPUP','FUNDING','ADMIN_CREDIT')), 0)::numeric AS deposit_total,
        COALESCE(SUM(amount) FILTER (WHERE type ILIKE '%withdraw%' OR type = 'PAYOUT'), 0)::numeric AS withdrawal_total
      FROM wallet_ledger
    `),
  ]);

  const u = uRows[0];
  const t = tRows[0];
  const d = dRows[0];

  return {
    total_users:  u.total_users,
    admin_users:  u.admin_users,
    new_users_7d: u.new_users_7d,
    new_users_30d: u.new_users_30d,
    total_balance: Number(u.total_balance || 0),
    total_held:    Number(u.total_held || 0),
    total_transactions: t.total,
    successful_transactions: t.successful,
    failed_transactions: t.failed,
    pending_transactions: t.pending,
    total_volume: Number(t.volume || 0),
    total_profit: Number(t.profit || 0),
    total_deposits: Number(d.deposit_total || 0),
    deposit_count: d.deposit_count,
    total_withdrawals: Number(d.withdrawal_total || 0),
    withdrawal_count: d.withdrawal_count,
  };
}

/* ============================================================
   MISMATCHES
   ============================================================ */
export async function listMismatches({ resolved = false, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM audit_mismatches
      WHERE resolved = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [resolved, limit]
  ).catch(() => ({ rows: [] }));
  return rows;
}

export async function resolveMismatch({ mismatchId, note, adminId }) {
  const { rows } = await query(
    `UPDATE audit_mismatches
        SET resolved = TRUE,
            resolved_by = $1,
            resolved_at = NOW(),
            resolution_note = $2
      WHERE id = $3
      RETURNING *`,
    [adminId, note || 'Reviewed', mismatchId]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

/* ============================================================
   RECENT ACTIONS / FUNDING STATS
   ============================================================ */
export async function listRecentActions({ limit = 50, actionType = null } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (actionType) {
    params.push(actionType);
    where += ` AND event_type = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await query(
    `SELECT id, event_type, user_id, wallet_id, reference, amount,
            balance_before, balance_after, actor, source, details, created_at
       FROM money_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  ).catch(() => ({ rows: [] }));
  return rows;
}

export async function getFundingStats(days = 7) {
  const { rows } = await query(
    `SELECT
        DATE_TRUNC('day', created_at) AS day,
        COUNT(*)::int AS count,
        COALESCE(SUM(amount), 0)::numeric AS total
       FROM wallet_ledger
      WHERE type IN ('WALLET_TOPUP','TOPUP','FUNDING','ADMIN_CREDIT','DEPOSIT')
        AND created_at > NOW() - INTERVAL '1 day' * $1
      GROUP BY day
      ORDER BY day DESC`,
    [days]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/* ============================================================
   ARCHIVED TRANSACTIONS
   ============================================================ */
export async function searchArchivedTransactions({ query: q = '', userId = null, page = 1, limit = 50 } = {}) {
  const params = [];
  const where = [];

  if (q) {
    params.push(`%${q}%`);
    where.push(`(reference ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  if (userId) {
    params.push(userId);
    where.push(`user_id = $${params.length}`);
  }

  const offset = (Math.max(page, 1) - 1) * limit;
  params.push(limit, offset);

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await query(
    `SELECT * FROM transactions_archive
       ${whereSql}
       ORDER BY original_created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  ).catch(() => ({ rows: [] }));

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::int AS total FROM transactions_archive ${whereSql}`,
    params.slice(0, params.length - 2)
  ).catch(() => ({ rows: [{ total: 0 }] }));

  return {
    items: rows,
    page: Math.max(page, 1),
    perPage: limit,
    total: cnt[0]?.total || 0,
  };
}

/* ============================================================
   DEFAULT EXPORT
   ============================================================ */
export default {
  findUser,
  getUserFullDetails,
  manualFund,
  manualDebit,
  listWalletDrift,
  getDashboardStats,
  listMismatches,
  resolveMismatch,
  listRecentActions,
  getFundingStats,
  searchArchivedTransactions,
};