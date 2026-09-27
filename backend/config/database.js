// config/database.js
// ============================================================
// PostgreSQL connection pool
//   ⭐ Uses DATABASE_URL only — no PGHOST/PGUSER overrides.
//   ⭐ Adds SSL for production (Render Postgres requires it).
// ============================================================
import pg from 'pg';
import { env } from '../env/env.js';

const { Pool } = pg;

/* ────────────────────────────────────────────────────────────
   Build the pool config.
   If DATABASE_URL is set, use ONLY connectionString — mixing
   it with host/user/password makes pg ignore the URL.
   ──────────────────────────────────────────────────────────── */
const useUrl = Boolean(env.DATABASE_URL);
const urlIsLocal = useUrl && /@(localhost|127\.0\.0\.1)[:/]/i.test(env.DATABASE_URL);

const poolConfig = useUrl
  ? {
      connectionString: env.DATABASE_URL,
      // Render Postgres (and most cloud PG) requires SSL.
      // External URLs also usually want SSL. Local dev typically doesn't.
      ssl: urlIsLocal || env.isDev
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    }
  : {
      host:     env.PGHOST     || 'localhost',
      port:     Number(env.PGPORT) || 5432,
      database: env.PGDATABASE,
      user:     env.PGUSER,
      password: env.PGPASSWORD,
      ssl: false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    };

/* ── Log which mode we're using (helps debug on Render) ── */
if (useUrl) {
  try {
    const u = new URL(env.DATABASE_URL);
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname);
    console.log(`[db] mode: URL`);
    console.log(`[db] host: ${u.hostname}`);
    console.log(`[db] port: ${u.port || 5432}`);
    console.log(`[db] name: ${u.pathname.slice(1)}`);
    console.log(`[db] user: ${u.username}`);
    console.log(`[db] ssl : ${poolConfig.ssl ? 'ON' : 'OFF'}`);
    if (isLocal && process.env.NODE_ENV === 'production') {
      console.error('[db] ⚠⚠⚠ DATABASE_URL points to LOCALHOST in production!');
      console.error('[db] ⚠⚠⚠ Render cannot reach localhost. Use the Internal Database URL.');
    }
  } catch {
    console.error('[db] ⚠ DATABASE_URL is not a valid URL');
  }
} else {
  console.log(`[db] mode: PGHOST/PGUSER fields (no DATABASE_URL set)`);
  console.log(`[db] host: ${poolConfig.host}:${poolConfig.port}`);
  console.log(`[db] name: ${poolConfig.database}`);
}

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/* ────────────────────────────────────────────────────────────
   QUERY HELPERS
   ──────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────
   TEST CONNECTION — verbose on failure
   ──────────────────────────────────────────────────────────── */
export async function testConnection() {
  try {
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
  } catch (err) {
    console.error('[db] ❌ connection FAILED');
    console.error('[db]    name    :', err?.name);
    console.error('[db]    code    :', err?.code);
    console.error('[db]    message :', err?.message);
    if (err?.errors && Array.isArray(err.errors)) {
      console.error('[db]    sub-errors:');
      for (const e of err.errors) {
        console.error(`[db]      → ${e.code || '?'} ${e.message || ''}`);
      }
    }
    console.error('[db]    stack   :', err?.stack);
    throw err;
  }
}

export default pool;
