import { query } from '../config/database.js';

export async function listTransactions({ userId, limit = 20, offset = 0, type, status }) {
  const where = ['user_id = $1'];
  const params = [userId];

  if (type) { params.push(type); where.push(`type = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }

  params.push(limit, offset);

  const result = await query(
    `SELECT id, reference, type, service, direction, amount, status,
            description, metadata, created_at
     FROM transactions
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM transactions WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );

  return {
    items: result.rows.map(formatTx),
    total: countResult.rows[0].total,
    limit,
    offset,
  };
}

export async function getTransaction({ userId, reference }) {
  const result = await query(
    `SELECT id, reference, type, service, direction, amount, status,
            description, metadata, provider_reference,
            created_at, updated_at
     FROM transactions
     WHERE user_id = $1 AND reference = $2
     LIMIT 1`,
    [userId, reference]
  );
  if (result.rows.length === 0) return null;
  return formatTx(result.rows[0]);
}

export async function recentTransactions(userId, limit = 4) {
  return listTransactions({ userId, limit, offset: 0 });
}

function formatTx(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    service: row.service,
    direction: row.direction,
    amount: Number(row.amount),
    status: row.status,
    description: row.description,
    metadata: row.metadata,
    providerReference: row.provider_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}