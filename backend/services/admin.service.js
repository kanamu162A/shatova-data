// services/admin.service.js
// ============================================================
// Shatova — Admin Service
//   • Manual wallet funding / debiting with full audit trail
//   • Manual fund/debit ALSO writes to transactions so the
//     entry appears in admin + user transaction history.
//   • Dashboard stats, mismatches, wallet drift
//   • User details with fresh wallet balance
//   • Users table uses single `name` column (no first_name/last_name)
// ============================================================

import { query } from '../config/database.js';
import * as wallet from './wallet.service.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ============================================================
   Find user by id / email / phone
   ============================================================ */
export async function findUser({ userId, email, phone }) {
  if (!userId && !email && !phone) return null;

  let sql = `SELECT id, name, email, phone
               FROM users WHERE 1=1`;
  const params = [];

  if (userId) {
    params.push(Number(userId));
    sql += ` AND id = $${params.length}`;
  } else {
    if (email) {
      params.push(String(email).toLowerCase().trim());
      sql += ` AND LOWER(email) = $${params.length}`;
    }
    if (phone) {
      const clean = String(phone).replace(/\D/g, '');
      params.push(clean);
      sql += ` AND REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $${params.length}`;
    }
  }

  sql += ' LIMIT 1';
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

/* ============================================================
   FULL USER DETAILS
   ============================================================ */
export async function getUserFullDetails({ userId, email, phone }) {
  if (!userId && !email && !phone) throw new Error('Provide user_id, email, or phone');

  const conds  = [];
  const params = [];

  if (userId) {
    params.push(Number(userId));
    conds.push(`u.id = $${params.length}`);
  } else {
    if (email) {
      params.push(String(email).toLowerCase().trim());
      conds.push(`LOWER(u.email) = $${params.length}`);
    }
    if (phone) {
      const clean = String(phone).replace(/\D/g, '');
      params.push(clean);
      conds.push(`REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = $${params.length}`);
    }
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  if (!where) throw new Error('No search criteria provided');

  const { rows } = await query(
    `SELECT
       u.id, u.name, u.email, u.phone, u.role,
       u.is_verified, u.is_active,
       u.last_login_at, u.created_at, u.updated_at,
       u.review_flag,
       COALESCE(w.balance, 0)       AS balance,
       COALESCE(w.held_balance, 0)  AS held_balance,
       w.status                     AS wallet_status,
       w.id                         AS wallet_id,
       (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id)::int AS transaction_count,
       (SELECT COALESCE(SUM(amount), 0) FROM transactions t
          WHERE t.user_id = u.id AND UPPER(t.status) = 'SUCCESS' AND t.direction = 'DEBIT') AS total_spent,
       (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger l
          WHERE l.user_id = u.id AND l.direction = 'CREDIT') AS total_funded
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     ${where}
     LIMIT 1`,
    params
  );

  return rows[0] || null;
}

/* ============================================================
   MANUAL FUND
   ------------------------------------------------------------
   1. Writes wallet_ledger entry (via wallet.creditWallet)
   2. Writes a matching `transactions` row so it shows in
      history + admin panels
   3. Logs the admin action
   ============================================================ */
export async function manualFund({
  adminId, adminEmail, userId, amount, reason,
  source = 'support', metadata = {},
}) {
  if (!adminId)               throw new Error('Admin ID is required');
  if (!userId)                throw new Error('User ID is required');
  if (!amount || amount <= 0) throw new Error('Amount must be greater than zero');
  if (!reason || !String(reason).trim()) throw new Error('Reason is required');

  const numAmount   = money(amount);
  const cleanReason = String(reason).trim().slice(0, 500);

  const { rows: userRows } = await query(
    `SELECT id, name, email, phone
       FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const user = userRows[0];
  if (!user) throw new Error('Target user not found');

  const reference = wallet.generateUniqueReference('MANUAL-FUND');

  // 1) Ledger + wallet balance (existing behavior)
  const result = await wallet.creditWallet({
    userId,
    amount:      numAmount,
    reference,
    type:        'MANUAL_CREDIT',
    description: `Manual funding — ${cleanReason}`,
    transactionId: null,
  });

  const walletBefore = money(result.before);
  const walletAfter  = money(result.after);

  // 2) Write to `transactions` so it appears in history everywhere.
  //    Uses the same reference so ledger & txn can be linked.
  let txnRow = null;
  try {
    const { rows: txnRows } = await query(
      `INSERT INTO transactions
         (user_id, reference, type, service, direction,
          amount, final_amount, status,
          description, metadata, created_at, updated_at)
       VALUES ($1,$2,'MANUAL_CREDIT','manual_fund','CREDIT',
          $3,$3,'SUCCESS',
          $4,$5::jsonb,NOW(),NOW())
       RETURNING *`,
      [
        userId,
        reference,
        numAmount,
        `Manual funding — ${cleanReason}`,
        JSON.stringify({
          source,
          admin_id:      adminId,
          admin_email:   adminEmail || null,
          reason:        cleanReason,
          wallet_before: walletBefore,
          wallet_after:  walletAfter,
          direction:     'credit',
          kind:          'manual_fund',
          ...metadata,
        }),
      ]
    );
    txnRow = txnRows[0] || null;
  } catch (txnErr) {
    // Don't fail the whole fund if the txn insert hiccups — the ledger
    // entry already landed. Log loudly for ops.
    console.error('[admin.fund] ⚠️ transactions insert failed:', txnErr.message);
  }

  // 3) Admin audit log
  await query(
    `INSERT INTO admin_actions
       (admin_id, admin_email, action_type, target_user_id,
        amount, reason, reference, source, metadata)
     VALUES ($1, $2, 'MANUAL_FUND', $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      adminId, adminEmail || null, userId, numAmount,
      cleanReason, reference, source,
      JSON.stringify({
        wallet_before: walletBefore,
        wallet_after:  walletAfter,
        idempotent:    !!result.idempotent,
        transaction_id: txnRow?.id || null,
        ...metadata,
      }),
    ]
  );

  console.log(
    `[admin.fund] ✅ ${adminEmail || adminId} → user ${userId} | ` +
    `₦${numAmount} | ${reference} | ${walletBefore} → ${walletAfter}`
  );

  return {
    reference,
    userId,
    user: {
      id:    user.id,
      name:  user.name || null,
      email: user.email,
      phone: user.phone,
    },
    amount:        numAmount,
    wallet_before: walletBefore,
    wallet_after:  walletAfter,
    reason:        cleanReason,
    source,
    idempotent:    !!result.idempotent,
    transaction:   txnRow, // ⭐ returned to controller → SSE payload
    created_at:    new Date().toISOString(),
  };
}

/* ============================================================
   MANUAL DEBIT
   ------------------------------------------------------------
   1. Writes wallet_ledger entry (via wallet.debitWallet)
   2. Writes a matching `transactions` row so it shows in
      history + admin panels
   3. Logs the admin action
   ============================================================ */
export async function manualDebit({
  adminId, adminEmail, userId, amount, reason,
  source = 'correction', metadata = {},
}) {
  if (!adminId)               throw new Error('Admin ID is required');
  if (!userId)                throw new Error('User ID is required');
  if (!amount || amount <= 0) throw new Error('Amount must be greater than zero');
  if (!reason || !String(reason).trim()) throw new Error('Reason is required');

  const numAmount   = money(amount);
  const cleanReason = String(reason).trim().slice(0, 500);

  const { rows: userRows } = await query(
    `SELECT id, name, email, phone
       FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const user = userRows[0];
  if (!user) throw new Error('Target user not found');

  const reference = wallet.generateUniqueReference('MANUAL-DEBIT');

  // 1) Ledger + wallet balance
  const result = await wallet.debitWallet({
    userId,
    amount:      numAmount,
    reference,
    type:        'MANUAL_DEBIT',
    description: `Manual debit — ${cleanReason}`,
    transactionId: null,
  });

  const walletBefore = money(result.before);
  const walletAfter  = money(result.after);

  // 2) Mirror into `transactions` for history
  let txnRow = null;
  try {
    const { rows: txnRows } = await query(
      `INSERT INTO transactions
         (user_id, reference, type, service, direction,
          amount, final_amount, status,
          description, metadata, created_at, updated_at)
       VALUES ($1,$2,'MANUAL_DEBIT','manual_debit','DEBIT',
          $3,$3,'SUCCESS',
          $4,$5::jsonb,NOW(),NOW())
       RETURNING *`,
      [
        userId,
        reference,
        numAmount,
        `Manual debit — ${cleanReason}`,
        JSON.stringify({
          source,
          admin_id:      adminId,
          admin_email:   adminEmail || null,
          reason:        cleanReason,
          wallet_before: walletBefore,
          wallet_after:  walletAfter,
          direction:     'debit',
          kind:          'manual_debit',
          ...metadata,
        }),
      ]
    );
    txnRow = txnRows[0] || null;
  } catch (txnErr) {
    console.error('[admin.debit] ⚠️ transactions insert failed:', txnErr.message);
  }

  // 3) Admin audit log
  await query(
    `INSERT INTO admin_actions
       (admin_id, admin_email, action_type, target_user_id,
        amount, reason, reference, source, metadata)
     VALUES ($1, $2, 'MANUAL_DEBIT', $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      adminId, adminEmail || null, userId, numAmount,
      cleanReason, reference, source,
      JSON.stringify({
        wallet_before: walletBefore,
        wallet_after:  walletAfter,
        idempotent:    !!result.idempotent,
        transaction_id: txnRow?.id || null,
        ...metadata,
      }),
    ]
  );

  console.log(
    `[admin.debit] ✅ ${adminEmail || adminId} → user ${userId} | ` +
    `-₦${numAmount} | ${reference} | ${walletBefore} → ${walletAfter}`
  );

  return {
    reference,
    userId,
    user: {
      id:    user.id,
      name:  user.name || null,
      email: user.email,
      phone: user.phone,
    },
    amount:        numAmount,
    wallet_before: walletBefore,
    wallet_after:  walletAfter,
    reason:        cleanReason,
    source,
    idempotent:    !!result.idempotent,
    transaction:   txnRow, // ⭐ returned to controller → SSE payload
    created_at:    new Date().toISOString(),
  };
}

/* ============================================================
   LIST RECENT ADMIN ACTIONS
   ============================================================ */
export async function listRecentActions({ limit = 50, actionType = null } = {}) {
  const params = [];
  let where = 'WHERE 1=1';

  if (actionType) {
    params.push(actionType);
    where += ` AND a.action_type = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 50, 200));

  const { rows } = await query(
    `SELECT a.*,
            u.name  AS target_name,
            u.email AS target_email,
            u.phone AS target_phone,
            COALESCE(
              NULLIF(TRIM(COALESCE(u.name, '')), ''),
              u.email,
              u.phone,
              '#' || a.target_user_id
            ) AS target_display
       FROM admin_actions a
       LEFT JOIN users u ON u.id = a.target_user_id
       ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/* ============================================================
   STATS
   ============================================================ */
export async function getFundingStats(days = 7) {
  const { rows } = await query(
    `SELECT
       action_type,
       COUNT(*)::int             AS count,
       COALESCE(SUM(amount), 0)  AS total_amount
     FROM admin_actions
     WHERE created_at > NOW() - INTERVAL '${Number(days)} days'
     GROUP BY action_type`
  );
  return rows;
}

/* ============================================================
   DASHBOARD STATS
   ============================================================ */
export async function getDashboardStats() {
  const { rows: [stats] } = await query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int AS total_users,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new_users_24h,
      (SELECT COUNT(*) FROM transactions WHERE created_at::date = CURRENT_DATE)::int   AS txs_today,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions
        WHERE direction = 'DEBIT' AND status = 'SUCCESS'
          AND created_at::date = CURRENT_DATE)                           AS volume_today,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions
        WHERE direction = 'DEBIT' AND status = 'SUCCESS'
          AND created_at > NOW() - INTERVAL '30 days')                   AS volume_30d,
      (SELECT COALESCE(SUM(profit), 0) FROM transactions
        WHERE status = 'SUCCESS'
          AND created_at > NOW() - INTERVAL '30 days')                   AS profit_30d,
      (SELECT COUNT(*) FROM transactions WHERE UPPER(status) = 'PROCESSING')::int AS processing_count,
      (SELECT COUNT(*) FROM transactions WHERE UPPER(status) = 'FAILED'
          AND created_at > NOW() - INTERVAL '24 hours')::int              AS failed_24h,
      (SELECT COUNT(*) FROM audit_mismatches WHERE resolved = FALSE)::int AS open_mismatches,
      (SELECT COALESCE(SUM(balance), 0) FROM wallets)                    AS total_wallet_balance
  `);

  return {
    total_users:          Number(stats.total_users          || 0),
    new_users_24h:        Number(stats.new_users_24h        || 0),
    txs_today:            Number(stats.txs_today            || 0),
    volume_today:         Number(stats.volume_today         || 0),
    volume_30d:           Number(stats.volume_30d           || 0),
    profit_30d:           Number(stats.profit_30d           || 0),
    processing_count:     Number(stats.processing_count     || 0),
    failed_24h:           Number(stats.failed_24h           || 0),
    open_mismatches:      Number(stats.open_mismatches      || 0),
    total_wallet_balance: Number(stats.total_wallet_balance || 0),
  };
}

/* ============================================================
   ARCHIVED TRANSACTIONS
   ============================================================ */
export async function searchArchivedTransactions({ query: q, userId, page = 1, limit = 50 } = {}) {
  const params = [];
  const conds  = [];

  if (q) {
    params.push(`%${String(q).trim()}%`);
    conds.push(`(reference ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  if (userId) {
    params.push(Number(userId));
    conds.push(`user_id = $${params.length}`);
  }

  const where  = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const offset = (Math.max(1, page) - 1) * limit;

  const { rows } = await query(
    `SELECT * FROM transactions_archive
     ${where}
      ORDER BY original_created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM transactions_archive ${where}`,
    params
  );

  return { items: rows, total: count, page, limit };
}

/* ============================================================
   MISMATCHES
   ============================================================ */
export async function listMismatches({ resolved = false, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT m.*, u.email AS user_email, u.phone AS user_phone, u.name AS user_name
       FROM audit_mismatches m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.resolved = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [!!resolved, limit]
  );
  return rows;
}

export async function resolveMismatch({ mismatchId, note, adminId }) {
  const { rows } = await query(
    `UPDATE audit_mismatches
        SET resolved = TRUE,
            resolution_note = $1
      WHERE id = $2
      RETURNING *`,
    [String(note || '').slice(0, 500), mismatchId]
  );
  if (!rows.length) throw new Error('Mismatch not found');
  console.log(`[admin] mismatch ${mismatchId} resolved by admin ${adminId}`);
  return rows[0];
}

/* ============================================================
   WALLET DRIFT
   ============================================================ */
export async function listWalletDrift() {
  const { rows } = await query(`
    WITH last_settled AS (
      SELECT DISTINCT ON (wallet_id)
            wallet_id, balance_after
        FROM wallet_ledger
      WHERE LOWER(COALESCE(status, 'successful')) NOT IN ('pending', 'processing')
      ORDER BY wallet_id, created_at DESC, id DESC
    ),
    active_holds AS (
      SELECT wallet_id, COALESCE(SUM(amount), 0) AS held_sum
        FROM wallet_holds
      WHERE status = 'HELD'
      GROUP BY wallet_id
    )
    SELECT
      w.id                                       AS wallet_id,
      w.user_id,
      u.email                                    AS user_email,
      u.phone                                    AS user_phone,
      w.balance                                  AS wallet_balance,
      COALESCE(ls.balance_after, 0)              AS ledger_balance,
      COALESCE(ah.held_sum, 0)                   AS active_held_sum,
      (COALESCE(ls.balance_after, 0)
        - COALESCE(ah.held_sum, 0))              AS expected_balance,
      (w.balance - (COALESCE(ls.balance_after, 0)
        - COALESCE(ah.held_sum, 0)))             AS drift
      FROM wallets w
      LEFT JOIN last_settled ls ON ls.wallet_id = w.id
      LEFT JOIN active_holds ah ON ah.wallet_id = w.id
      LEFT JOIN users u ON u.id = w.user_id
     WHERE w.balance IS DISTINCT FROM
           (COALESCE(ls.balance_after, 0) - COALESCE(ah.held_sum, 0))
     ORDER BY ABS(w.balance - (COALESCE(ls.balance_after, 0) - COALESCE(ah.held_sum, 0))) DESC
     LIMIT 100
  `);
  return rows;
}

/* ============================================================
   Default export
   ============================================================ */
export default {
  findUser,
  getUserFullDetails,
  manualFund,
  manualDebit,
  listRecentActions,
  getFundingStats,
  getDashboardStats,
  searchArchivedTransactions,
  listMismatches,
  resolveMismatch,
  listWalletDrift,
};
