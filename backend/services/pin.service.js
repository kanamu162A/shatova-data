// services/auth.service.js
// ============================================================
// Auth service — register, login, PIN, getMe
// ============================================================

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { env } from '../env/env.js';

/* ============================================================
   HELPERS
   ============================================================ */
const SALT_ROUNDS = 10;

function signToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role || 'USER',
  };
  const expiresIn = env.JWT_EXPIRES_IN || '37d';
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn });
}

function publicUser(row) {
  if (!row) return null;
  return {
    id:              row.id,
    name:            row.name,
    email:           row.email,
    phone:           row.phone,
    role:            row.role,
    is_verified:     row.is_verified,
    is_active:       row.is_active,
    balance:         row.balance != null ? Number(row.balance) : 0,
    held_balance:    row.held_balance != null ? Number(row.held_balance) : 0,
    has_pin:         !!row.pin_hash,
    has_biometric:   !!row.biometric_credential_id,
    created_at:      row.created_at,
  };
}

/* ============================================================
   REGISTER
   ============================================================ */
export async function register({ name, email, phone, password }) {
  /* Check for existing user (email or phone) */
  const existing = await query(
    `SELECT id, email, phone FROM users
      WHERE LOWER(email) = LOWER($1) OR phone = $2
      LIMIT 1`,
    [email, phone]
  );
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (String(row.email).toLowerCase() === String(email).toLowerCase()) {
      return { ok: false, code: 'EMAIL_EXISTS', message: 'An account with this email already exists' };
    }
    return { ok: false, code: 'PHONE_EXISTS', message: 'An account with this phone already exists' };
  }

  /* Hash password */
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  /* Insert user */
  const { rows } = await query(
    `INSERT INTO users (name, email, phone, password_hash, role, is_verified, is_active)
     VALUES ($1, LOWER($2), $3, $4, 'USER', TRUE, TRUE)
     RETURNING id, name, email, phone, role, is_verified, is_active, created_at`,
    [name, email, phone, passwordHash]
  );

  const user = rows[0];

  /* Create wallet for the new user */
  await query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  const token = signToken(user);

  return {
    ok: true,
    token,
    user: publicUser({ ...user, pin_hash: null }),
  };
}

/* ============================================================
   LOGIN — accepts { identifier, isEmail, password }
   ============================================================ */
export async function login({ identifier, isEmail, password }) {
  let row;

  if (isEmail) {
    const { rows } = await query(
      `SELECT id, name, email, phone, password_hash, pin_hash,
              role, is_verified, is_active, biometric_credential_id,
              created_at
         FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1`,
      [identifier]
    );
    row = rows[0];
  } else {
    const { rows } = await query(
      `SELECT id, name, email, phone, password_hash, pin_hash,
              role, is_verified, is_active, biometric_credential_id,
              created_at
         FROM users
        WHERE phone = $1
        LIMIT 1`,
      [identifier]
    );
    row = rows[0];
  }

  if (!row) {
    return { ok: false, code: 'USER_NOT_FOUND', message: 'No account found' };
  }

  if (!row.is_active) {
    return { ok: false, code: 'ACCOUNT_DISABLED', message: 'Account is disabled' };
  }

  const okPwd = await bcrypt.compare(password, row.password_hash);
  if (!okPwd) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Incorrect password' };
  }

  /* Fetch wallet balance */
  let balance = 0;
  try {
    const w = await query(`SELECT balance FROM wallets WHERE user_id = $1 LIMIT 1`, [row.id]);
    if (w.rows[0]) balance = Number(w.rows[0].balance);
  } catch { /* wallet may not exist yet */ }

  /* Update last_login_at */
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [row.id]);

  const token = signToken(row);

  return {
    ok: true,
    token,
    user: publicUser({ ...row, balance }),
  };
}

/* ============================================================
   SET PIN — hash & store in users.pin_hash
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

  if (!rowCount) {
    throw new Error('User not found');
  }

  return true;
}

/* ============================================================
   VERIFY PIN — compare against users.pin_hash
   ============================================================ */
export async function verifyPin(userId, pin) {
  if (!userId) return { ok: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return { ok: false, code: 'PIN_INVALID', message: 'PIN must be 4 digits' };
  }

  const { rows } = await query(
    `SELECT pin_hash FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!rows.length) {
    return { ok: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  const stored = rows[0].pin_hash;
  if (!stored) {
    return { ok: false, code: 'PIN_NOT_SET', message: 'No PIN has been set' };
  }

  const ok = await bcrypt.compare(String(pin), stored);
  if (!ok) {
    return { ok: false, code: 'PIN_INVALID', message: 'Incorrect PIN' };
  }

  return { ok: true };
}

/* ============================================================
   GET ME — user + wallet balance
   ============================================================ */
export async function getMe(userId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role,
            u.is_verified, u.is_active, u.created_at,
            u.pin_hash, u.biometric_credential_id,
            COALESCE(w.balance, 0)      AS balance,
            COALESCE(w.held_balance, 0) AS held_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId]
  );

  if (!rows.length) return null;
  return publicUser(rows[0]);
}