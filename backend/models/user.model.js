// models/userModel.js
// ============================================================
// Shatova — User Model
//   • Auth methods (findByEmail, create, comparePassword, JWT)
//   • Admin methods (list, search, count, detail, stats)
// ============================================================

import pool from '../config/database.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../env/env.js';

/* ============================================================
   HELPERS
   ============================================================ */
function escapeLike(str) {
  return String(str).replace(/[%_\\]/g, c => '\\' + c);
}

const User = {
  /* ============================================================
     AUTH
     ============================================================ */
  async findByEmail(email) {
    const result = await pool.query(
      `SELECT id, name, email, password, phone, role, created_at, updated_at
         FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await pool.query(
      `SELECT id, name, email, password, phone, role, created_at, updated_at
         FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByPhone(phone) {
    const result = await pool.query(
      'SELECT id, name, email, phone, role FROM users WHERE phone = $1 LIMIT 1',
      [phone]
    );
    return result.rows[0] || null;
  },

  async create({ name, email, password, phone, address, city, state, nin, bvn }) {
    const hashedPassword = await bcrypt.hash(password, config.security.bcryptRounds);

    const result = await pool.query(
      `INSERT INTO users (name, email, password, phone, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, email, phone, role, created_at`,
      [name.trim(), email.toLowerCase().trim(), hashedPassword, phone.trim()]
    );

    return result.rows[0];
  },

  async comparePassword(user, candidatePassword) {
    if (!user || !user.password || !candidatePassword) return false;
    try {
      return await bcrypt.compare(candidatePassword, user.password);
    } catch (err) {
      console.error('[user] bcrypt.compare error:', err.message);
      return false;
    }
  },

  generateToken(user) {
    return jwt.sign(
      {
        id: user.id.toString(),
        email: user.email,
        name: user.name,
        role: user.role || 'user',
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
  },

  async checkEmailExists(email) {
    const { rows } = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)) AS exists',
      [email]
    );
    return rows[0].exists;
  },

  async checkPhoneExists(phone) {
    const { rows } = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE phone = $1) AS exists',
      [phone]
    );
    return rows[0].exists;
  },

  /* ============================================================
     ADMIN — LIST
     Returns paginated users with wallet balance + txn count.
     ============================================================ */
  async listForAdmin({ limit = 100, offset = 0, search = '', role = null, status = null } = {}) {
    const params = [];
    const where = [];

    if (search) {
      const like = `%${escapeLike(search)}%`;
      params.push(like);
      where.push(`(
        u.name  ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR u.phone ILIKE $${params.length}
      )`);
    }

    if (role) {
      params.push(role.toLowerCase());
      where.push(`LOWER(u.role) = $${params.length}`);
    }

    /* status filter — only apply if the column exists */
    if (status) {
      const { rows: col } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'status' LIMIT 1`
      );
      if (col.length) {
        params.push(status.toLowerCase());
        where.push(`LOWER(u.status) = $${params.length}`);
      }
    }

    params.push(limit, offset);

    const sql = `
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.role,
        u.created_at,
        COALESCE(w.balance, 0)::numeric       AS balance,
        COALESCE(w.held_balance, 0)::numeric  AS held_balance,
        COALESCE(w.status, 'ACTIVE')          AS wallet_status,
        COALESCE(t.txn_count, 0)::int         AS transaction_count,
        COALESCE(t.last_txn_at, NULL)         AS last_transaction_at
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN (
        SELECT user_id,
               COUNT(*)::int          AS txn_count,
               MAX(created_at)        AS last_txn_at
          FROM transactions
         GROUP BY user_id
      ) t ON t.user_id = u.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await pool.query(sql, params);

    return rows.map(r => ({
      ...r,
      balance:      Number(r.balance || 0),
      held_balance: Number(r.held_balance || 0),
      status:       r.wallet_status === 'ACTIVE' ? 'active' : 'suspended',
    }));
  },

  async countForAdmin({ search = '', role = null, status = null } = {}) {
    const params = [];
    const where = [];

    if (search) {
      const like = `%${escapeLike(search)}%`;
      params.push(like);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }
    if (role) {
      params.push(role.toLowerCase());
      where.push(`LOWER(u.role) = $${params.length}`);
    }
    if (status) {
      const { rows: col } = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'status' LIMIT 1`
      );
      if (col.length) {
        params.push(status.toLowerCase());
        where.push(`LOWER(u.status) = $${params.length}`);
      }
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    );
    return rows[0]?.total || 0;
  },

  /* ============================================================
     ADMIN — DETAIL (single user, full profile + wallet + stats)
     ============================================================ */
  async getDetails(userId) {
    /* Core user + wallet + txn aggregates */
    const { rows } = await pool.query(
      `SELECT
         u.*,
         COALESCE(w.balance, 0)::numeric       AS balance,
         COALESCE(w.held_balance, 0)::numeric  AS held_balance,
         COALESCE(w.status, 'ACTIVE')          AS wallet_status,
         COALESCE(w.daily_limit, 0)::numeric   AS daily_limit,
         COALESCE(w.daily_spent, 0)::numeric   AS daily_spent,
         COALESCE(w.currency, 'NGN')           AS currency,
         COALESCE(t.total_txns, 0)::int        AS total_transactions,
         COALESCE(t.success_txns, 0)::int      AS successful_transactions,
         COALESCE(t.failed_txns, 0)::int       AS failed_transactions,
         COALESCE(t.total_spent, 0)::numeric   AS total_spent,
         COALESCE(t.last_txn_at, NULL)         AS last_transaction_at,
         COALESCE(d.total_deposits, 0)::numeric AS total_deposits,
         COALESCE(d.deposit_count, 0)::int     AS deposit_count,
         COALESCE(wi.total_withdrawals, 0)::numeric AS total_withdrawals,
         COALESCE(wi.withdrawal_count, 0)::int      AS withdrawal_count
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id,
                COUNT(*)                                                    AS total_txns,
                COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')           AS success_txns,
                COUNT(*) FILTER (WHERE UPPER(status) = 'FAILED')            AS failed_txns,
                COALESCE(SUM(amount) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0) AS total_spent,
                MAX(created_at)                                             AS last_txn_at
           FROM transactions
          GROUP BY user_id
       ) t ON t.user_id = u.id
       LEFT JOIN (
         SELECT user_id,
                COALESCE(SUM(amount), 0) AS total_deposits,
                COUNT(*)                 AS deposit_count
           FROM wallet_ledger
          WHERE type ILIKE '%deposit%' OR type IN ('WALLET_TOPUP','TOPUP','FUNDING')
          GROUP BY user_id
       ) d ON d.user_id = u.id
       LEFT JOIN (
         SELECT user_id,
                COALESCE(SUM(amount), 0) AS total_withdrawals,
                COUNT(*)                 AS withdrawal_count
           FROM wallet_ledger
          WHERE type ILIKE '%withdraw%' OR type = 'PAYOUT'
          GROUP BY user_id
       ) wi ON wi.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );

    const user = rows[0];
    if (!user) return null;

    /* Strip sensitive fields */
    delete user.password;
    delete user.otp_code;
    delete user.otp_expires_at;
    delete user.otp_attempts;
    delete user.reset_token;
    delete user.reset_token_expires_at;

    /* Recent activity — last 10 transactions */
    const { rows: recentTx } = await pool.query(
      `SELECT id, reference, type, service, amount, status, network, description, created_at
         FROM transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [userId]
    );

    /* Recent ledger — last 10 wallet movements */
    const { rows: recentLedger } = await pool.query(
      `SELECT id, reference, type, direction, amount, balance_after, description, created_at
         FROM wallet_ledger
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 10`,
      [userId]
    );

    return {
      user: {
        ...user,
        balance:      Number(user.balance || 0),
        held_balance: Number(user.held_balance || 0),
        daily_limit:  Number(user.daily_limit || 0),
        daily_spent:  Number(user.daily_spent || 0),
        status:       user.wallet_status === 'ACTIVE' ? 'active' : 'suspended',
      },
      stats: {
        total_transactions:      Number(user.total_transactions || 0),
        successful_transactions: Number(user.successful_transactions || 0),
        failed_transactions:     Number(user.failed_transactions || 0),
        total_spent:             Number(user.total_spent || 0),
        total_deposits:          Number(user.total_deposits || 0),
        deposit_count:           Number(user.deposit_count || 0),
        total_withdrawals:       Number(user.total_withdrawals || 0),
        withdrawal_count:        Number(user.withdrawal_count || 0),
        last_transaction_at:     user.last_transaction_at,
      },
      recent_transactions: recentTx.map(t => ({ ...t, amount: Number(t.amount || 0) })),
      recent_ledger:       recentLedger.map(l => ({
        ...l,
        amount:        Number(l.amount || 0),
        balance_after: Number(l.balance_after || 0),
      })),
    };
  },

  /* ============================================================
     ADMIN — UPDATE (role / status)
     ============================================================ */
  async updateRole(userId, role) {
    const { rows } = await pool.query(
      `UPDATE users SET role = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, email, role, updated_at`,
      [userId, role.toLowerCase()]
    );
    return rows[0] || null;
  },

  /* ============================================================
     ADMIN — STATS (overview cards)
     ============================================================ */
  async adminStats() {
    const { rows: userRows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users)                        AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE role = 'admin')   AS admin_users,
        (SELECT COUNT(*)::int FROM users
          WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')  AS new_users_7d,
        (SELECT COUNT(*)::int FROM users
          WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') AS new_users_30d,
        (SELECT COALESCE(SUM(balance), 0)::numeric FROM wallets) AS total_balance,
        (SELECT COALESCE(SUM(held_balance), 0)::numeric FROM wallets) AS total_held
    `);
    const u = userRows[0];

    return {
      total_users:   Number(u.total_users || 0),
      admin_users:   Number(u.admin_users || 0),
      new_users_7d:  Number(u.new_users_7d || 0),
      new_users_30d: Number(u.new_users_30d || 0),
      total_balance: Number(u.total_balance || 0),
      total_held:    Number(u.total_held || 0),
    };
  },
};

export default User;