// models/transactionModel.js
// ============================================================
// Transaction model — reads and writes for the `transactions` table
// Schema: id, user_id, reference, type, service, direction, amount,
//         status, provider_reference, metadata, description,
//         created_at, updated_at, cost_price, profit,
//         provider_ref, discount, final_amount, remark, network
// ============================================================

import { query } from '../config/database.js';

const Transaction = {

  /* ============================================================
     USER-FACING — list one user's purchases
     ============================================================ */
  async listForUser({
    userId,
    limit = 30,
    offset = 0,
    service = null,      // 'airtime' | 'data' | null
    status = null,       // 'success' | 'failed' | 'pending' | null
    from = null,
    to = null,
    search = '',
  } = {}) {
    const params = [userId];
    const where = [`t.user_id = $1`];

    if (service) {
      params.push(service.toLowerCase());
      where.push(`(
        LOWER(COALESCE(t.service,'')) = $${params.length}
        OR LOWER(COALESCE(t.type,'')) = $${params.length}
      )`);
    }
    if (status) {
      params.push(status.toLowerCase());
      where.push(`LOWER(t.status) = $${params.length}`);
    }
    if (from) { params.push(from); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    if (to)   { params.push(to);   where.push(`t.created_at <= $${params.length}::timestamptz`); }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        t.reference ILIKE $${params.length}
        OR t.provider_reference ILIKE $${params.length}
        OR t.description ILIKE $${params.length}
        OR t.metadata->>'phone' ILIKE $${params.length}
        OR t.metadata->>'product_name' ILIKE $${params.length}
      )`);
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT
         t.id, t.reference, t.type, t.service, t.direction,
         t.amount, t.final_amount, t.cost_price, t.profit, t.discount,
         t.status, t.provider_reference, t.provider_ref,
         t.network, t.metadata, t.description, t.remark,
         t.created_at, t.updated_at
       FROM transactions t
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return rows.map(mapRow);
  },

  async countForUser({
    userId,
    service = null,
    status = null,
    from = null,
    to = null,
    search = '',
  } = {}) {
    const params = [userId];
    const where = [`user_id = $1`];

    if (service) {
      params.push(service.toLowerCase());
      where.push(`(LOWER(COALESCE(service,'')) = $${params.length} OR LOWER(COALESCE(type,'')) = $${params.length})`);
    }
    if (status) { params.push(status.toLowerCase()); where.push(`LOWER(status) = $${params.length}`); }
    if (from)   { params.push(from); where.push(`created_at >= $${params.length}::timestamptz`); }
    if (to)     { params.push(to);   where.push(`created_at <= $${params.length}::timestamptz`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        reference ILIKE $${params.length}
        OR provider_reference ILIKE $${params.length}
        OR description ILIKE $${params.length}
        OR metadata->>'phone' ILIKE $${params.length}
        OR metadata->>'product_name' ILIKE $${params.length}
      )`);
    }

    const { rows } = await query(
      `SELECT COUNT(*)::int AS total FROM transactions
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    );
    return rows[0]?.total || 0;
  },

  /* ============================================================
     ADMIN — full history across all users
     ============================================================ */
  async listForAdmin({
    limit = 200,
    offset = 0,
    search = '',
    service = null,
    status = null,
    from = null,
    to = null,
    userId = null,
  } = {}) {
    const params = [];
    const where = [];

    if (userId) { params.push(userId); where.push(`t.user_id = $${params.length}::int`); }
    if (service) {
      params.push(service.toLowerCase());
      where.push(`(
        LOWER(COALESCE(t.service,'')) = $${params.length}
        OR LOWER(COALESCE(t.type,'')) = $${params.length}
      )`);
    }
    if (status) { params.push(status.toLowerCase()); where.push(`LOWER(t.status) = $${params.length}`); }
    if (from)   { params.push(from); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    if (to)     { params.push(to);   where.push(`t.created_at <= $${params.length}::timestamptz`); }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        t.reference ILIKE $${params.length}
        OR t.provider_reference ILIKE $${params.length}
        OR t.description ILIKE $${params.length}
        OR t.metadata->>'phone' ILIKE $${params.length}
        OR t.metadata->>'product_name' ILIKE $${params.length}
        OR u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
      )`);
    }

    params.push(limit, offset);

    const { rows } = await query(
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
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return rows.map(mapRow);
  },

  async countForAdmin({
    search = '',
    service = null,
    status = null,
    from = null,
    to = null,
    userId = null,
  } = {}) {
    const params = [];
    const where = [];

    if (userId) { params.push(userId); where.push(`t.user_id = $${params.length}::int`); }
    if (service) {
      params.push(service.toLowerCase());
      where.push(`(LOWER(COALESCE(t.service,'')) = $${params.length} OR LOWER(COALESCE(t.type,'')) = $${params.length})`);
    }
    if (status) { params.push(status.toLowerCase()); where.push(`LOWER(t.status) = $${params.length}`); }
    if (from)   { params.push(from); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    if (to)     { params.push(to);   where.push(`t.created_at <= $${params.length}::timestamptz`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        t.reference ILIKE $${params.length}
        OR t.provider_reference ILIKE $${params.length}
        OR t.description ILIKE $${params.length}
        OR t.metadata->>'phone' ILIKE $${params.length}
        OR t.metadata->>'product_name' ILIKE $${params.length}
        OR u.name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
      )`);
    }

    const { rows } = await query(
      `SELECT COUNT(*)::int AS total
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    );
    return rows[0]?.total || 0;
  },

  /* ============================================================
     SINGLE RECORD
     ============================================================ */
  async findById(id, userId = null) {
    const params = [id];
    let sql = `
      SELECT t.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
       WHERE t.id = $1
    `;
    if (userId) { params.push(userId); sql += ` AND t.user_id = $2`; }
    sql += ' LIMIT 1';

    const { rows } = await query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async findByReference(reference, userId = null) {
    const params = [reference];
    let sql = `SELECT * FROM transactions WHERE reference = $1`;
    if (userId) { params.push(userId); sql += ` AND user_id = $2`; }
    sql += ' LIMIT 1';

    const { rows } = await query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /* ============================================================
     STATS — for admin dashboard
     ============================================================ */
  async stats({ from = null, to = null } = {}) {
    const params = [];
    const conds = [];
    if (from) { params.push(from); conds.push(`created_at >= $${params.length}::timestamptz`); }
    if (to)   { params.push(to);   conds.push(`created_at <= $${params.length}::timestamptz`); }
    const whereClause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')::int  AS successful,
         COUNT(*) FILTER (WHERE UPPER(status) = 'FAILED')::int   AS failed,
         COUNT(*) FILTER (WHERE UPPER(status) IN ('PENDING','PROCESSING'))::int AS pending,

         COALESCE(SUM(amount) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS volume,
         COALESCE(SUM(profit) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS profit,

         COUNT(*) FILTER (
           WHERE LOWER(COALESCE(service,'')) = 'airtime' OR LOWER(COALESCE(type,'')) = 'vtu'
         )::int AS airtime_count,
         COUNT(*) FILTER (
           WHERE LOWER(COALESCE(service,'')) = 'data' OR LOWER(COALESCE(type,'')) = 'data'
         )::int AS data_count,

         COALESCE(SUM(amount) FILTER (
           WHERE (LOWER(COALESCE(service,'')) = 'airtime' OR LOWER(COALESCE(type,'')) = 'vtu')
             AND UPPER(status) = 'SUCCESS'
         ), 0)::numeric AS airtime_volume,
         COALESCE(SUM(amount) FILTER (
           WHERE (LOWER(COALESCE(service,'')) = 'data' OR LOWER(COALESCE(type,'')) = 'data')
             AND UPPER(status) = 'SUCCESS'
         ), 0)::numeric AS data_volume
       FROM transactions
       ${whereClause}`,
      params
    );
    return rows[0];
  },
};

/* ============================================================
   Row mapper — normalizes numeric fields to Number
   ============================================================ */
function mapRow(r) {
  return {
    ...r,
    amount:       r.amount != null ? Number(r.amount) : 0,
    final_amount: r.final_amount != null ? Number(r.final_amount) : null,
    cost_price:   r.cost_price != null ? Number(r.cost_price) : null,
    profit:       r.profit != null ? Number(r.profit) : null,
    discount:     r.discount != null ? Number(r.discount) : null,
    metadata:     r.metadata || {},
  };
}

export default Transaction;