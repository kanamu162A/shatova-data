import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../config/database.js';
import { env } from '../env/env.js';
import { sendPasswordResetEmail } from './email.service.js';

const TOKEN_BYTES = 32;

export async function requestReset({ identifier, ip }) {
  const result = await query(
    `SELECT id, name, email FROM users
     WHERE phone = $1 OR email = $1
     LIMIT 1`,
    [identifier]
  );

  if (result.rows.length === 0) return { ok: true, silent: true };

  const user = result.rows[0];
  if (!user.email) {
    return { ok: false, message: 'No email on file. Contact support.' };
  }

  await query(
    `UPDATE password_resets SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const expiresAt = new Date(Date.now() + env.RESET_TOKEN_TTL_MIN * 60 * 1000);

  await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, ip_address)
     VALUES ($1, $2, $3, $4)`,
    [user.id, tokenHash, expiresAt, ip || null]
  );

  const resetLink = `${env.FRONTEND_URL}/reset-password.html?token=${rawToken}&uid=${user.id}`;

  const sendResult = await sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    resetLink,
  });

  if (!sendResult.ok) {
    return { ok: false, message: 'Failed to send reset email. Try again later.' };
  }

  return { ok: true };
}

export async function verifyResetToken({ userId, token }) {
  const result = await query(
    `SELECT id, token_hash, expires_at, used_at
     FROM password_resets
     WHERE user_id = $1 AND used_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) return { ok: false, code: 'INVALID_TOKEN' };

  const row = result.rows[0];

  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, code: 'TOKEN_EXPIRED' };
  }

  const match = await bcrypt.compare(token, row.token_hash);
  if (!match) return { ok: false, code: 'INVALID_TOKEN' };

  return { ok: true, resetId: row.id };
}

export async function completeReset({ userId, token, newPassword }) {
  const check = await verifyResetToken({ userId, token });
  if (!check.ok) return { ok: false, code: check.code };

  const passwordHash = await bcrypt.hash(newPassword, 10);

  const client = await (await import('../config/database.js')).pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    );
    await client.query(
      'UPDATE password_resets SET used_at = NOW() WHERE id = $1',
      [check.resetId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { ok: true };
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) return { ok: false, code: 'USER_NOT_FOUND' };

  const match = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!match) return { ok: false, code: 'WRONG_PASSWORD' };

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);

  return { ok: true };
}