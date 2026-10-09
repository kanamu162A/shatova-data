// controllers/admin.controller.js
// ============================================================
// Shatova — Admin Controller
//   • Users, transactions, stats
//   • Datashop wallet: fetches LIVE balance from Datashop API
//     Reads env vars: VTU_API_KEY + VTU_API_BASE (fallback:
//     DATASHOP_API_KEY + DATASHOP_BASE_URL)
//   • Manual fund/debit writes to BOTH wallet_ledger AND
//     the transactions table so it appears in history.
//   • Manual fund/debit broadcasts an SSE event so the
//     admin dashboard updates instantly.
// ============================================================

import User from '../models/user.model.js';
import { query } from '../config/database.js';
import * as adminService from '../services/admin.service.js';
import { archiveAndTrimTransactions } from '../jobs/daily-transaction-archive.job.js';
import { adminEventBus } from '../events/adminEventBus.js';

const MAX_LIMIT = 500;
const paging = (req) => ({
  limit:  Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_LIMIT),
  offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
});

/* ============================================================
   GET /api/v1/admin/users
   ============================================================ */
export async function getUsers(req, res) {
  try {
    const { limit, offset } = paging(req);
    const search = String(req.query.search || '').trim();
    const role   = req.query.role   ? String(req.query.role).trim()   : null;
    const status = req.query.status ? String(req.query.status).trim() : null;

    const [users, total] = await Promise.all([
      User.listForAdmin({ limit, offset, search, role, status }),
      User.countForAdmin({ search, role, status }),
    ]);

    return res.json({
      success: true,
      data: { users, total, limit, offset },
      meta: { total, limit, offset, hasMore: offset + users.length < total },
    });
  } catch (err) {
    console.error('[admin] getUsers:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch users.' });
  }
}

/* ============================================================
   GET /api/v1/admin/users/:id
   ============================================================ */
export async function getUser(req, res) {
  try {
    const result = await User.getDetails(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin] getUser:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch user.' });
  }
}

/* ============================================================
   PATCH /api/v1/admin/users/:id/role
   ============================================================ */
export async function updateUserRole(req, res) {
  try {
    const role = String(req.body?.role || '').trim().toLowerCase();
    const allowed = ['user', 'admin', 'super_admin', 'owner'];
    if (!allowed.includes(role)) {
      return res.status(422).json({ success: false, message: `Role must be: ${allowed.join(', ')}` });
    }

    const updated = await User.updateRole(req.params.id, role);
    if (!updated) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({ success: true, message: `Role set to ${role}`, data: { user: updated } });
  } catch (err) {
    console.error('[admin] updateUserRole:', err);
    return res.status(500).json({ success: false, message: 'Could not update role.' });
  }
}

/* ============================================================
   GET /api/v1/admin/transactions
   ============================================================ */
export async function getTransactions(req, res) {
  try {
    const { limit, offset } = paging(req);
    const search  = String(req.query.search  || '').trim();
    const service = req.query.service ? String(req.query.service).trim().toLowerCase() : null;
    const status  = req.query.status  ? String(req.query.status).trim().toLowerCase()  : null;
    const from    = req.query.from    || null;
    const to      = req.query.to      || null;
    const userId  = req.query.userId  || null;

    const params = [];
    const where = [];

    if (userId) { params.push(userId); where.push(`t.user_id = $${params.length}::int`); }
    if (service) {
      params.push(service);
      where.push(`(LOWER(COALESCE(t.service,'')) = $${params.length} OR LOWER(COALESCE(t.type,'')) = $${params.length})`);
    }
    if (status) { params.push(status); where.push(`LOWER(t.status) = $${params.length}`); }
    if (from)   { params.push(from); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    if (to)     { params.push(to);   where.push(`t.created_at <= $${params.length}::timestamptz`); }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(t.reference ILIKE $${params.length} OR t.provider_reference ILIKE $${params.length} OR t.description ILIKE $${params.length} OR t.metadata->>'phone' ILIKE $${params.length} OR t.metadata->>'product_name' ILIKE $${params.length})`);
    }

    params.push(limit, offset);

    const { rows: transactions } = await query(
      `SELECT
         t.id, t.user_id, t.reference, t.type, t.service, t.direction,
         t.amount, t.final_amount, t.cost_price, t.profit, t.discount,
         t.status, t.provider_reference, t.provider_ref,
         t.network, t.metadata, t.description, t.remark,
         t.created_at, t.updated_at,
         u.name  AS user_name,
         u.email AS user_email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS total FROM transactions t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      countParams
    );
    const total = cnt[0]?.total || 0;

    return res.json({
      success: true,
      data: {
        transactions: transactions.map(t => ({
          ...t,
          amount:       Number(t.amount || 0),
          final_amount: t.final_amount != null ? Number(t.final_amount) : null,
          cost_price:   t.cost_price   != null ? Number(t.cost_price)   : null,
          profit:       t.profit       != null ? Number(t.profit)       : null,
          discount:     t.discount     != null ? Number(t.discount)     : null,
        })),
        total, limit, offset,
      },
      meta: { total, limit, offset, hasMore: offset + transactions.length < total },
    });
  } catch (err) {
    console.error('[admin] getTransactions:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transactions.' });
  }
}

/* ============================================================
   GET /api/v1/admin/transaction/:id
   ============================================================ */
export async function getTransaction(req, res) {
  try {
    const { rows } = await query(
      `SELECT t.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Transaction not found' });
    return res.json({ success: true, data: { transaction: rows[0] } });
  } catch (err) {
    console.error('[admin] getTransaction:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transaction.' });
  }
}

/* ============================================================
   GET /api/v1/admin/stats
   ============================================================ */
export async function getStats(req, res) {
  try {
    const [userStats, { rows: txnRows }, { rows: ledgerRows }] = await Promise.all([
      User.adminStats(),
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')::int AS successful,
          COUNT(*) FILTER (WHERE UPPER(status) = 'FAILED')::int  AS failed,
          COUNT(*) FILTER (WHERE UPPER(status) IN ('PENDING','PROCESSING'))::int AS pending,
          COALESCE(SUM(amount) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS volume,
          COALESCE(SUM(profit) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS profit,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(service,'')) = 'airtime' OR LOWER(COALESCE(type,'')) = 'vtu')::int AS airtime_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(service,'')) = 'data'    OR LOWER(COALESCE(type,'')) = 'data')::int AS data_count,
          COALESCE(SUM(amount) FILTER (WHERE (LOWER(COALESCE(service,'')) = 'airtime' OR LOWER(COALESCE(type,'')) = 'vtu') AND UPPER(status) = 'SUCCESS'), 0)::numeric AS airtime_volume,
          COALESCE(SUM(amount) FILTER (WHERE (LOWER(COALESCE(service,'')) = 'data'    OR LOWER(COALESCE(type,'')) = 'data') AND UPPER(status) = 'SUCCESS'), 0)::numeric AS data_volume
        FROM transactions
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE type ILIKE '%deposit%' OR type IN ('WALLET_TOPUP','TOPUP','FUNDING'))::int AS deposit_count,
          COUNT(*) FILTER (WHERE type ILIKE '%withdraw%' OR type = 'PAYOUT')::int AS withdrawal_count,
          COALESCE(SUM(amount) FILTER (WHERE type ILIKE '%deposit%' OR type IN ('WALLET_TOPUP','TOPUP','FUNDING')), 0)::numeric AS deposit_total,
          COALESCE(SUM(amount) FILTER (WHERE type ILIKE '%withdraw%' OR type = 'PAYOUT'), 0)::numeric AS withdrawal_total
        FROM wallet_ledger
      `),
    ]);

    const txns = txnRows[0];
    const ledger = ledgerRows[0];
    const decided = (txns.successful || 0) + (txns.failed || 0);
    const successRate = decided > 0 ? Math.round((txns.successful / decided) * 100) : 0;

    return res.json({
      success: true,
      data: {
        totalUsers:   userStats.total_users,
        adminUsers:   userStats.admin_users,
        newUsers7d:   userStats.new_users_7d,
        newUsers30d:  userStats.new_users_30d,
        totalBalance: userStats.total_balance,
        totalHeld:    userStats.total_held,

        totalDeposits:    Number(ledger.deposit_total || 0),
        depositCount:     ledger.deposit_count || 0,
        totalWithdrawals: Number(ledger.withdrawal_total || 0),
        withdrawalCount:  ledger.withdrawal_count || 0,
        pendingWithdrawals: 0,

        airtimeSales: Number(txns.airtime_volume || 0),
        airtimeCount: txns.airtime_count || 0,
        dataSales:    Number(txns.data_volume || 0),
        dataCount:    txns.data_count || 0,

        successRate,
        totalProfit: Number(txns.profit || 0),
        totalTransactions: txns.total || 0,
        successfulTransactions: txns.successful || 0,
        failedTransactions: txns.failed || 0,
        pendingTransactions: txns.pending || 0,

        counts: {
          users:        userStats.total_users,
          transactions: txns.total || 0,
          deposits:     ledger.deposit_count || 0,
          withdrawals:  ledger.withdrawal_count || 0,
        },
      },
    });
  } catch (err) {
    console.error('[admin] getStats:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch stats.' });
  }
}

/* ============================================================
   ⭐ GET /api/v1/admin/datashop/wallet
   Fetches LIVE Datashop balance + local funding history.

   Reads credentials from (in priority order):
     1. VTU_API_KEY  / VTU_API_BASE          (your Render env)
     2. DATASHOP_API_KEY / DATASHOP_BASE_URL (fallback)

   Handles both base URL formats:
     • https://app.datashop.africa          → appends /api/v2
     • https://app.datashop.africa/api/v2   → uses as-is
   ============================================================ */
export async function getDatashopWallet(req, res) {
  const fallback = {
    success: true,
    data: {
      balance: 0,
      total_funded: 0,
      total_spent: 0,
      last_funding_at: null,
      source: 'fallback',
    },
  };

  try {
    // ---------------------------------------------------------
    // 1. Local funding history (from our own DB)
    // ---------------------------------------------------------
    let localFunded = 0, localSpent = 0, lastFundingAt = null;
    try {
      const { rows } = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN UPPER(direction) = 'CREDIT' THEN amount END), 0)::numeric AS total_funded,
           COALESCE(SUM(CASE WHEN UPPER(direction) = 'DEBIT'  THEN amount END), 0)::numeric AS total_spent,
           MAX(created_at) FILTER (WHERE UPPER(direction) = 'CREDIT') AS last_funding_at
         FROM transactions
         WHERE UPPER(type) IN ('DATASHOP_FUNDING', 'DATASHOP_TOPUP')`
      );
      const r = rows[0] || {};
      localFunded   = Number(r.total_funded || 0);
      localSpent    = Number(r.total_spent  || 0);
      lastFundingAt = r.last_funding_at || null;
    } catch (dbErr) {
      console.warn('[admin] Datashop local history query failed:', dbErr.message);
    }

    // ---------------------------------------------------------
    // 2. Resolve credentials from env
    // ---------------------------------------------------------
    const apiKey =
      process.env.VTU_API_KEY ||
      process.env.DATASHOP_API_KEY ||
      null;

    const rawBase = (
      process.env.VTU_API_BASE ||
      process.env.DATASHOP_BASE_URL ||
      'https://app.datashop.africa'
    ).replace(/\/+$/, '');

    // If base already ends with /api/vN, don't append again.
    const hasApiSuffix = /\/api\/v\d+$/i.test(rawBase);
    const apiPath = hasApiSuffix ? rawBase.match(/\/api\/v\d+$/i)[0] : '/api/v2';
    const baseUrl = hasApiSuffix ? rawBase.replace(/\/api\/v\d+$/i, '') : rawBase;
    const endpoint = `${baseUrl}${apiPath}/account/wallet-balance`;

    let liveBalance = 0;
    let liveSource  = 'local';
    let debugInfo   = null;

    if (!apiKey) {
      console.warn('[admin] Datashop API key missing — check VTU_API_KEY env var.');
      debugInfo = { error: 'VTU_API_KEY not set' };
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const resp = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const raw = await resp.text();
        let json = {};
        try { json = JSON.parse(raw); } catch (_) { json = { raw }; }

        console.log('[admin] Datashop wallet response', {
          endpoint,
          status: resp.status,
          body: json,
        });

        if (resp.ok) {
          // Tolerate multiple response shapes
          const candidate =
            json?.data?.balance ??
            json?.data?.wallet?.balance ??
            json?.data?.available_balance ??
            json?.balance ??
            json?.wallet?.balance ??
            null;

          if (candidate != null && !Number.isNaN(Number(candidate))) {
            liveBalance = Number(candidate);
            liveSource  = 'datashop_api';
          } else {
            console.warn('[admin] Datashop API returned 200 but no recognizable balance field. Body:', json);
            debugInfo = { endpoint, status: resp.status, body: json };
          }
        } else {
          console.warn('[admin] Datashop API returned non-OK:', resp.status, json);
          debugInfo = { endpoint, status: resp.status, body: json };
        }
      } catch (apiErr) {
        console.warn('[admin] Datashop API fetch failed:', apiErr.message, { endpoint });
        debugInfo = { endpoint, error: apiErr.message };
      }
    }

    // ---------------------------------------------------------
    // 3. Merge + respond
    // ---------------------------------------------------------
    return res.json({
      success: true,
      data: {
        balance:         liveBalance,
        total_funded:    localFunded,
        total_spent:     localSpent,
        last_funding_at: lastFundingAt,
        source:          liveSource,
        debug:           process.env.NODE_ENV !== 'production' ? debugInfo : undefined,
      },
    });
  } catch (err) {
    console.error('[admin] getDatashopWallet:', err);
    return res.json(fallback);
  }
}

/* ============================================================
   ⭐ Dashboard
   ============================================================ */
export async function getDashboard(req, res) {
  try {
    const [stats, drift, mismatches] = await Promise.all([
      adminService.getDashboardStats(),
      adminService.listWalletDrift(),
      adminService.listMismatches({ resolved: false, limit: 10 }),
    ]);
    res.json({ success: true, data: { stats, drift, mismatches } });
  } catch (err) {
    console.error('[admin.getDashboard]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   ⭐ Manual Fund — writes BOTH ledger + transactions
   ============================================================ */
export async function manualFund(req, res) {
  const admin = {
    id:    req.user?._id || req.user?.id || req.user?.userId,
    email: req.user?.email || null,
    name:  req.user?.name  || null,
  };
  if (!admin.id) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { user_id, email, phone, amount, reason, source = 'support' } = req.body || {};

  if (!user_id && !email && !phone) {
    return res.status(400).json({ success: false, message: 'Provide user_id, email, or phone' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be > 0' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, message: 'reason is required' });
  }

  try {
    const user = await adminService.findUser({ userId: user_id, email, phone });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const result = await adminService.manualFund({
      adminId:    admin.id,
      adminEmail: admin.email,
      adminName:  admin.name,
      userId:     user.id,
      amount:     Number(amount),
      reason,
      source,
    });

    try {
      adminEventBus.emitAdmin('admin-funded', {
        kind:   'manual_fund',
        userId: user.id,
        amount: Number(amount),
        reason,
        source,
        transaction: result.transaction || null,
      });
    } catch (_) {}

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin.manualFund]', err);
    res.status(500).json({ success: false, message: err.message || 'Funding failed' });
  }
}

/* ============================================================
   ⭐ Manual Debit — writes BOTH ledger + transactions
   ============================================================ */
export async function manualDebit(req, res) {
  const admin = {
    id:    req.user?._id || req.user?.id || req.user?.userId,
    email: req.user?.email || null,
    name:  req.user?.name  || null,
  };
  if (!admin.id) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { user_id, email, phone, amount, reason, source = 'correction' } = req.body || {};

  if (!user_id && !email && !phone) {
    return res.status(400).json({ success: false, message: 'Provide user_id, email, or phone' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be > 0' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, message: 'reason is required' });
  }

  try {
    const user = await adminService.findUser({ userId: user_id, email, phone });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const result = await adminService.manualDebit({
      adminId:    admin.id,
      adminEmail: admin.email,
      adminName:  admin.name,
      userId:     user.id,
      amount:     Number(amount),
      reason,
      source,
    });

    try {
      adminEventBus.emitAdmin('admin-debited', {
        kind:   'manual_debit',
        userId: user.id,
        amount: Number(amount),
        reason,
        source,
        transaction: result.transaction || null,
      });
    } catch (_) {}

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin.manualDebit]', err);
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 400 : 500;
    res.status(status).json({
      success: false,
      code:    err.code || 'DEBIT_FAILED',
      message: err.message || 'Debit failed',
      data:    err.data  || null,
    });
  }
}

/* ============================================================
   Lookup user for Manual Fund
   ============================================================ */
export async function lookupUser(req, res) {
  const { user_id, email, phone } = req.query || {};
  if (!user_id && !email && !phone) {
    return res.status(400).json({ success: false, message: 'Provide user_id, email, or phone' });
  }

  try {
    const user = await adminService.findUser({ userId: user_id, email, phone });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { rows: wRows } = await query(
      `SELECT balance, held_balance FROM wallets WHERE user_id = $1 LIMIT 1`,
      [user.id]
    );
    const wallet = wRows[0] || { balance: 0, held_balance: 0 };

    res.json({
      success: true,
      data: {
        user: {
          ...user,
          balance:      Number(wallet.balance),
          held_balance: Number(wallet.held_balance),
        },
      },
    });
  } catch (err) {
    console.error('[admin.lookupUser]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Admin Actions Log
   ============================================================ */
export async function listActions(req, res) {
  try {
    const limit       = Math.min(Number(req.query.limit) || 50, 200);
    const action_type = req.query.action_type || null;
    const actions     = await adminService.listRecentActions({ limit, actionType: action_type });
    res.json({ success: true, data: { actions } });
  } catch (err) {
    console.error('[admin.listActions]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function fundingStats(req, res) {
  try {
    const days  = Math.min(Number(req.query.days) || 7, 90);
    const stats = await adminService.getFundingStats(days);
    res.json({ success: true, data: { stats } });
  } catch (err) {
    console.error('[admin.fundingStats]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Archived transactions
   ============================================================ */
export async function listArchivedTransactions(req, res) {
  try {
    const result = await adminService.searchArchivedTransactions({
      query:  req.query.q,
      userId: req.query.user_id,
      page:   Number(req.query.page)  || 1,
      limit:  Math.min(Number(req.query.limit) || 50, 200),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin.listArchivedTransactions]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Archive trigger
   ============================================================ */
export async function triggerArchive(req, res) {
  try {
    const result = await archiveAndTrimTransactions();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[admin.triggerArchive]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Mismatches
   ============================================================ */
export async function listMismatches(req, res) {
  try {
    const rows = await adminService.listMismatches({
      resolved: req.query.resolved === 'true',
      limit:    Math.min(Number(req.query.limit) || 100, 200),
    });
    res.json({ success: true, data: { mismatches: rows } });
  } catch (err) {
    console.error('[admin.listMismatches]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function resolveMismatch(req, res) {
  try {
    const adminId = req.user?._id || req.user?.id || req.user?.userId;
    const { id } = req.params;
    const { note } = req.body || {};
    const row = await adminService.resolveMismatch({
      mismatchId: Number(id),
      note,
      adminId,
    });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('[admin.resolveMismatch]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Wallet drift
   ============================================================ */
export async function listWalletDrift(req, res) {
  try {
    const rows = await adminService.listWalletDrift();
    res.json({ success: true, data: { drift: rows } });
  } catch (err) {
    console.error('[admin.listWalletDrift]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* ============================================================
   Default export
   ============================================================ */
export default {
  getUsers,
  getUser,
  updateUserRole,
  getTransactions,
  getTransaction,
  getStats,
  getDatashopWallet,
  getDashboard,
  manualFund,
  manualDebit,
  lookupUser,
  listActions,
  fundingStats,
  listArchivedTransactions,
  triggerArchive,
  listMismatches,
  resolveMismatch,
  listWalletDrift,
};
