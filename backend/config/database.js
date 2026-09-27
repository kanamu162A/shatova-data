// config/database.js
import pg from 'pg';
import { env } from '../env/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (env.isDev && duration > 50) {
    console.log(`[DB] ${duration}ms | ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
  return result;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection() {
  const result = await pool.query('SELECT current_database() AS db');
  console.log(`PostgreSQL connected - db: ${result.rows[0].db}`);
}

/* Back-compat default export for `import pool from …` */
export default pool;