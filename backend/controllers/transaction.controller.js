// models/transaction.model.js
// ============================================================
// Shatova — Transaction Model
//   • listForUser / countForUser      (user-scoped history)
//   • listForAdmin / countForAdmin    (admin dashboard list)
//   • findById                        (single txn, optional owner scope)
//   • stats                           (aggregate stats)
//   • create                          (generic insert helper)
//
// ⭐ Admin listings include MANUAL_CREDIT / MANUAL_DEBIT so
//    manual fund/debit entries appear in the admin dashboard.
// ============================================================

import { query } from '../config/database.js';

/* ============================================================
   INTERNAL — Build shared WHERE clauses
   ============================================================ */
function buildFilters({
  userId,
  search,
  service,
  status,
  from,
  to,
  type,
  direction,
} = {}) {
  const params = [];
  const where  = [];

  if (userId) {
    params.push(Number(userId));
    where.push(`t.user_id = $${params.length}`);
  }

  if (type) {
    // Accepts a string or array of type values
    const list = Array.isArray(type) ? type : [type];
    params.push(list);
    where.push(`t.type = ANY($${params.length}::text[])`);
  }

  if (direction) {
    params.push(String(direction).toUpperCase());
    where.push(`UPPER(COALESCE(t.direction, '')) = $${params.length}`);
  }

  if (service) {
    // Matches either service OR type column (manual_fund appears in both)
    params.push(String(service).toLowerCase());
    where.push(
      `(LOWER(COALESCE(t.service, '')) = $${params.length}
        OR LOWER(COALESCE(t.type, ''))    = $${params.length})`
    );
  }

  if (status) {
    params.push(String(status).toLowerCase());
    where.push(`LOWER(COALESCE(t.status, '')) = $${params.length}`);
  }

  if (from) {
    params.push(from);
    where.push(`t.created_at >= $${params.length}::timestamptz`);
  }

  if (to) {
    params.push(to);
    where.push(`t.created_at <= $${params.length}::timestamptz`);
  }

  if (search) {
    const like = `%${String(search).trim()}%`;
    params.push(like);
    const i = params.length;
    where.push(`(
      t.reference            ILIKE $${i}
      OR t.provider_reference ILIKE $${i}
      OR t.provider_ref       ILIKE $${i}
      OR t.description        ILIKE $${i}
      OR t.remark             ILIKE $${i}
      OR t.metadata->>'phone'        ILIKE $${i}
      OR t.metadata->>'product_name' ILIKE $${i}
      OR u.name              ILIKE $${i}
      OR u.email             ILIKE $${i}
      OR u.phone             ILIKE $${i}
    )`);
  }

  return { where, params };
}

const BASE_COLUMNS = `
  t.id, t.user_id, t.reference, t.type, t.service, t.direction,
  t.amount, t.final_amount, t.cost_price, t.profit, t.discount,
  t.status, t.provider_reference, t.provider_ref,
  t.network, t.metadata, t.description, t.remark,
  t.created_at, t.updated_at,
  u.name  AS user_name,
  u.email AS user_email,
  u.phone AS user_phone
`;

/* ============================================================
   USER LIST — paginated transactions for one user
   ============================================================ */
export async function listForUser({
  userId,
  limit  = 30,
  offset = 0,
  service,
  status,
  from,
  to,
  search,
} = {}) {
  const { where, params } = buildFilters({
    userId, service, status, from, to, search,
  });

  params.push(limit, offset);

  const sql = `
    SELECT ${BASE_COLUMNS}
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const { rows } = await query(sql, params);
  return rows.map(normalize);
}

export async function countForUser({
  userId,
  service,
  status,
  from,
  to,
  search,
} = {}) {
  const { where, params } = buildFilters({
    userId, service, status, from, to, search,
  });

  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  );

  return rows[0]?.total || 0;
}

/* ============================================================
   ADMIN LIST — paginated transactions across all users
   ------------------------------------------------------------
   ⭐ Includes MANUAL_CREDIT / MANUAL_DEBIT by default so the
      admin dashboard shows manual fund/debit entries.
   ============================================================ */
export async function listForAdmin({
  limit  = 200,
  offset = 0,
  search,
  service,
  status,
  from,
  to,
  userId,
} = {}) {
  const { where, params } = buildFilters({
    userId, service, status, from, to, search,
  });

  // Always include manual fund/debit rows unless the caller has
  // explicitly filtered them out via `service`/`type`.
  const noServiceFilter = !service;
  if (noServiceFilter) {
    where.push(`(
      t.type    IN ('VTU','DATA','AIRTIME','DEPOSIT','WITHDRAWAL',
                    'MANUAL_CREDIT','MANUAL_DEBIT','TRANSFER','REFUND')
      OR t.service IN ('manual_fund','manual_debit','deposit','withdrawal',
                       'airtime','data','transfer','refund')
      OR t.metadata->>'kind' IN ('manual_fund','manual_debit')
    )`);
  }

  params.push(limit, offset);

  const sql = `
    SELECT ${BASE_COLUMNS}
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const { rows } = await query(sql, params);
  return rows.map(normalize);
}

export async function countForAdmin({
  search,
  service,
  status,
  from,
  to,
  userId,
} = {}) {
  const { where, params } = buildFilters({
    userId, service, status, from, to, search,
  });

  const noServiceFilter = !service;
  if (noServiceFilter) {
    where.push(`(
      t.type    IN ('VTU','DATA','AIRTIME','DEPOSIT','WITHDRAWAL',
                    'MANUAL_CREDIT','MANUAL_DEBIT','TRANSFER','REFUND')
      OR t.service IN ('manual_fund','manual_debit','deposit','withdrawal',
                       'airtime','data','transfer','refund')
      OR t.metadata->>'kind' IN ('manual_fund','manual_debit')
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
}

/* ============================================================
   FIND BY ID — optionally scoped to a user
   ============================================================ */
export async function findById(id, userId = null) {
  const params = [id];
  let whereUser = '';
  if (userId) {
    params.push(Number(userId));
    whereUser = ` AND t.user_id = $${params.length}`;
  }

  const { rows } = await query(
    `SELECT ${BASE_COLUMNS}
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id = $1${whereUser}
      LIMIT 1`,
    params
  );

  return rows[0] ? normalize(rows[0]) : null;
}

/* ============================================================
   STATS — aggregate metrics (admin stats endpoint)
   ============================================================ */
export async function stats({ from = null, to = null } = {}) {
  const params = [];
  const where  = [];

  if (from) { params.push(from); where.push(`created_at >= $${params.length}::timestamptz`); }
  if (to)   { params.push(to);   where.push(`created_at <= $${params.length}::timestamptz`); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')::int AS successful,
       COUNT(*) FILTER (WHERE UPPER(status) = 'FAILED')::int  AS failed,
       COUNT(*) FILTER (WHERE UPPER(status) IN ('PENDING','PROCESSING'))::int AS pending,
       COALESCE(SUM(amount) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS volume,
       COALESCE(SUM(profit) FILTER (WHERE UPPER(status) = 'SUCCESS'), 0)::numeric AS profit
     FROM transactions
     ${whereSql}`,
    params
  );

  return normalize(rows[0] || {});
}

/* ============================================================
   CREATE — generic insert helper
   ------------------------------------------------------------
   Kept for callers that need a low-level insert. Most flows
   (VTU, data, wallet, admin fund) do their own INSERTs.
   ============================================================ */
export async function create(tx = {}) {
  const {
    userId,
    reference,
    type = 'VTU',
    service = null,
    direction = 'DEBIT',
    amount = 0,
    finalAmount = null,
    costPrice = null,
    profit = null,
    discount = null,
    status = 'PENDING',
    providerReference = null,
    providerRef = null,
    network = null,
    metadata = {},
    description = null,
    remark = null,
  } = tx;

  const { rows } = await query(
    `INSERT INTO transactions
       (user_id, reference, type, service, direction,
        amount, final_amount, cost_price, profit, discount,
        status, provider_reference, provider_ref, network,
        metadata, description, remark, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,
             $6,$7,$8,$9,$10,
             $11,$12,$13,$14,
             $15::jsonb,$16,$17,NOW(),NOW())
     RETURNING *`,
    [
      userId, reference, type, service, direction,
      amount, finalAmount, costPrice, profit, discount,
      status, providerReference, providerRef, network,
      JSON.stringify(metadata || {}),
      description, remark,
    ]
  );

  return rows[0] ? normalize(rows[0]) : null;
}

/* ============================================================
   NORMALIZE — coerce numeric strings to numbers
   ============================================================ */
function normalize(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of ['amount', 'final_amount', 'cost_price', 'profit', 'discount']) {
    if (out[key] != null) out[key] = Number(out[key]);
  }
  return out;
}

/* ============================================================
   DEFAULT EXPORT
   ============================================================ */
export default {
  listForUser,
  countForUser,
  listForAdmin,
  countForAdmin,
  findById,
  stats,
  create,
};
