// env/env.js
import 'dotenv/config';

/* ────────────────────────────────────────────────────────────
   Database URL resolution (unchanged)
   ──────────────────────────────────────────────────────────── */
function cleanEnv(value) {
  if (value == null) return '';
  const v = String(value).trim();
  // Allow values copied into .env/Render without surrounding quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function resolveDatabaseUrl() {
  // Preferred: Render/Supabase/production connection string.
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  if (databaseUrl) return databaseUrl;

  // Fallback: individual PostgreSQL variables for local development.
  const PGHOST = cleanEnv(process.env.PGHOST);
  const PGPORT = cleanEnv(process.env.PGPORT) || '5432';
  const PGDATABASE = cleanEnv(process.env.PGDATABASE);
  const PGUSER = cleanEnv(process.env.PGUSER);
  const PGPASSWORD = cleanEnv(process.env.PGPASSWORD);

  if (PGHOST && PGDATABASE && PGUSER && PGPASSWORD) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }

  return null;
}

const DATABASE_URL = resolveDatabaseUrl();
const JWT_SECRET = cleanEnv(process.env.JWT_SECRET);

if (!DATABASE_URL) {
  throw new Error(
    'Missing DATABASE_URL. Add DATABASE_URL to Render Environment Variables or configure PGHOST, PGDATABASE, PGUSER and PGPASSWORD.'
  );
}

if (!JWT_SECRET) {
  throw new Error(
    'Missing JWT_SECRET. Add JWT_SECRET to Render Environment Variables.'
  );
}

/* ────────────────────────────────────────────────────────────
   Main env object
   ──────────────────────────────────────────────────────────── */
export const env = Object.freeze({
  PORT: Number(process.env.PORT) || 6000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  DATABASE_URL,

  JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',

  ADMIN_EMAILS: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  EMAIL_HOST: process.env.EMAIL_HOST || 'smtp.gmail.com',
  EMAIL_PORT: Number(process.env.EMAIL_PORT) || 587,
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASS: process.env.EMAIL_PASS || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Shatova',
  hasEmail: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS),

  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  RESET_TOKEN_TTL_MIN: 15,

  // VTU provider (DataShop)
  VTU_API_BASE: process.env.VTU_API_BASE || 'https://app.datashop.africa/api/v2',
  VTU_API_KEY:  process.env.VTU_API_KEY  || '',
  hasVTU:       Boolean(process.env.VTU_API_KEY),

  // Discounts
  AIRTIME_USER_DISCOUNT:     Number(process.env.AIRTIME_USER_DISCOUNT || 2),
  AIRTIME_USER_DISCOUNT_MIN: Number(process.env.AIRTIME_USER_DISCOUNT_MIN || 100),
  AIRTIME_DATASHOP_DISCOUNT: Number(process.env.AIRTIME_DATASHOP_DISCOUNT || 3),
  AIRTIME_PROFIT_MARGIN:     Number(process.env.AIRTIME_PROFIT_MARGIN || 0),

  // Used by userModel (bcrypt hash rounds, OTP lifetime, max attempts)
  BCRYPT_ROUNDS:      Number(process.env.BCRYPT_ROUNDS      || 10),
  OTP_EXPIRY_SECONDS: Number(process.env.OTP_EXPIRY_SECONDS || 600),
  MAX_OTP_ATTEMPTS:   Number(process.env.MAX_OTP_ATTEMPTS   || 5),

   DATASHOP_WEBHOOK_SECRET: process.env.DATASHOP_WEBHOOK_SECRET || '',

  // Monnify virtual accounts
  MONNIFY_BASE_URL: process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com',
  MONNIFY_API_KEY: process.env.MONNIFY_API_KEY || '',
  MONNIFY_SECRET_KEY: process.env.MONNIFY_SECRET_KEY || '',
  MONNIFY_CONTRACT_CODE: process.env.MONNIFY_CONTRACT_CODE || '',
  hasMonnify: Boolean(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY && process.env.MONNIFY_CONTRACT_CODE),

  // CORS allow-list — comma-separated. Includes Live Server defaults.
  CORS_ORIGINS: (process.env.CORS_ORIGINS ||
    'http://localhost:3000,http://localhost:5500,http://127.0.0.1:5500,http://localhost:5173'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 300),
  SERVE_STATIC:   process.env.SERVE_STATIC === 'true',
});

/* ────────────────────────────────────────────────────────────
   Backward-compat: some files may still import `config`
   ──────────────────────────────────────────────────────────── */
export const config = Object.freeze({
  env: env.NODE_ENV,
  port: env.PORT,

  jwt: {
    secret:    env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },

  security: {
    bcryptRounds:     env.BCRYPT_ROUNDS,
    otpExpirySeconds: env.OTP_EXPIRY_SECONDS,
    maxOtpAttempts:   env.MAX_OTP_ATTEMPTS,
  },

  cors: {
    origins: env.CORS_ORIGINS,
  },

  rateLimit: { max: env.RATE_LIMIT_MAX },
  static:    { serve: env.SERVE_STATIC },
});

/* ────────────────────────────────────────────────────────────
   Summary logger (unchanged + a few new lines)
   ──────────────────────────────────────────────────────────── */
export function logEnvSummary() {
  const f = (v) => (v ? 'on' : 'off');
  console.log('\n--- Environment ---');
  console.log(`  Mode:       ${env.NODE_ENV}`);
  console.log(`  Port:       ${env.PORT}`);
  console.log(`  Postgres:   on`);
  console.log(`  Email:      ${f(env.hasEmail)}`);
  console.log(`  Admins:     ${env.ADMIN_EMAILS.length}`);
  console.log(`  Frontend:   ${env.FRONTEND_URL}`);
  console.log(`  CORS:       ${env.CORS_ORIGINS.join(', ')}`);
  console.log(`  VTU:        ${f(env.hasVTU)} (${env.VTU_API_BASE})`);
  console.log(`  User disc:  ${env.AIRTIME_USER_DISCOUNT}% (from ₦${env.AIRTIME_USER_DISCOUNT_MIN})`);
  console.log(`  DS disc:    ${env.AIRTIME_DATASHOP_DISCOUNT}%`);
  console.log('-------------------\n');
}