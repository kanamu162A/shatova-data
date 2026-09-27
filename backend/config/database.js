// config/database.js
// ============================================================
// PostgreSQL connection pool
//   ⭐ Uses DATABASE_URL only — no PGHOST/PGUSER overrides.
// ============================================================
import pg from 'pg';
import { env } from '../env/env.js';

const { Pool } = pg;

/* Only pass connectionString when DATABASE_URL exists.
   Do NOT mix with host/user/password — pg ignores the URL otherwise. */
const poolConfig = env.DATABASE_URL
  ? {
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_URL.includes('render.com') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host:     env.PGHOST     || 'localhost',
      port:     Number(env.PGPORT) || 5432,
      database: env.PGDATABASE,
      user:     env.PGUSER,
      password: env.PGPASSWORD,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
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
  const { rows } = await pool.query(`
    SELECT
      current_database() AS db,
      current_user       AS usr,
      inet_server_addr() AS host,
      version()          AS version
  `);
  const r = rows[0];
  console.log(`[db] ✅ connected`);
  console.log(`[db]    database : ${r.db}`);
  console.log(`[db]    user     : ${r.usr}`);
  console.log(`[db]    host     : ${r.host}`);
  console.log(`[db]    version  : ${String(r.version).split(',')[0]}`);
}

export default pool;
