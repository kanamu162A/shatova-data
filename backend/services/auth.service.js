// services/auth.service.js
import bcrypt from 'bcrypt';
import { query } from '../config/database.js';
import { env } from '../env/env.js';
import { signToken } from '../utils/jwt.js';

const SALT_ROUNDS = 10;

/* ============================================================
   REGISTER
   ============================================================ */
export async function register({ name, phone, email, password }) {
  // 1. Check if phone or email already exists
  const existing = await query(
    'SELECT id FROM users WHERE phone = $1 OR email = $2 LIMIT 1',
    [phone, email]
  );
  if (existing.rows.length > 0) {
    return {
      ok: false,
      code: 'USER_EXISTS',
      message: 'Phone or email is already registered',
    };
  }

  // 2. Hash password
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // 3. Determine role (ADMIN if email is in the admin list)
  const adminEmails = Array.isArray(env.ADMIN_EMAILS) ? env.ADMIN_EMAILS : [];
  const role = adminEmails.includes(email.toLowerCase()) ? 'ADMIN' : 'USER';

  // 4. Insert user
  const userResult = await query(
    `INSERT INTO users (name, phone, email, password_hash, role, is_verified)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id, name, phone, email, role, is_verified`,
    [name, phone, email, passwordHash, role]
  );

  const user = userResult.rows[0];

  // 5. Create wallet for the new user
  await query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [user.id]);

  // 6. Sign token
  const token = signToken({ id: user.id, role: user.role });

  return {
    ok: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      isVerified: user.is_verified,
    },
  };
}

/* ============================================================
   LOGIN — accepts email OR phone
   ============================================================ */
export async function login({ identifier, isEmail, password }) {
  if (!identifier || !password) {
    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Email/phone and password are required',
    };
  }

  const sql = isEmail
    ? `SELECT id, name, phone, email, password_hash, pin_hash,
              role, is_verified, is_active
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`
    : `SELECT id, name, phone, email, password_hash, pin_hash,
              role, is_verified, is_active
       FROM users
       WHERE phone = $1
       LIMIT 1`;

  const result = await query(sql, [identifier]);

  if (result.rows.length === 0) {
    return {
      ok: false,
      code: 'USER_NOT_FOUND',
      message: 'No account found with that email or phone',
    };
  }

  const user = result.rows[0];

  if (!user.is_active) {
    return {
      ok: false,
      code: 'ACCOUNT_DISABLED',
      message: 'Your account has been disabled',
    };
  }

  if (!user.password_hash) {
    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'This account uses a different sign-in method',
    };
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Incorrect password',
    };
  }

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const token = signToken({ id: user.id, role: user.role });

  return {
    ok: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      isVerified: user.is_verified,
      hasPin: Boolean(user.pin_hash),
    },
  };
}

/* ============================================================
   SET PIN
   ------------------------------------------------------------
   Uses bcrypt directly — no external pinService dependency.
   ============================================================ */
export async function setPin(userId, pin) {
  if (!userId) throw new Error('userId is required');
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    throw new Error('PIN must be exactly 4 digits');
  }

  const hash = await bcrypt.hash(String(pin), SALT_ROUNDS);

  const { rowCount } = await query(
    `UPDATE users
        SET pin_hash   = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [hash, userId]
  );

  if (!rowCount) throw new Error('User not found');

  return { ok: true };
}

/* ============================================================
   VERIFY PIN
   ============================================================ */
export async function verifyPin(userId, pin) {
  if (!userId) return { ok: false, code: 'USER_NOT_FOUND' };
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return { ok: false, code: 'PIN_INVALID' };
  }

  const result = await query(
    'SELECT pin_hash FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );

  if (result.rows.length === 0) {
    return { ok: false, code: 'USER_NOT_FOUND' };
  }

  const { pin_hash } = result.rows[0];
  if (!pin_hash) {
    return { ok: false, code: 'PIN_NOT_SET' };
  }

  const match = await bcrypt.compare(String(pin), pin_hash);
  return match ? { ok: true } : { ok: false, code: 'PIN_INVALID' };
}

/* ============================================================
   GET ME
   ============================================================ */
export async function getMe(userId) {
  const result = await query(
    `SELECT u.id, u.name, u.phone, u.email, u.role,
            u.is_verified, u.is_active, u.pin_hash,
            u.last_login_at, u.created_at,
            w.balance, w.status AS wallet_status
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0) return null;

  const u = result.rows[0];

  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    isVerified: u.is_verified,
    isActive: u.is_active,
    walletStatus: u.wallet_status,
    balance: Number(u.balance || 0),
    hasPin: Boolean(u.pin_hash),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}