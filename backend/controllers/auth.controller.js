// controllers/auth.controller.js

import * as authService from '../services/auth.service.js';
import * as passwordReset from '../services/passwordReset.service.js';
import { query } from '../config/database.js';
import { success, error } from '../utils/response.js';
import {
  registerSchema,
  loginSchema,
  setPinSchema,
  verifyPinSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  validate,
} from '../utils/validation.js';

/* ============================================================
   REGISTER
   ============================================================ */
export async function register(req, res, next) {
  try {
    const v = validate(registerSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const result = await authService.register(v.data);
    if (!result.ok) return error(res, result.message, 400, result.code);

    return success(
      res,
      { token: result.token, user: result.user },
      'Registration successful',
      201
    );
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   LOGIN — accepts email OR phone
   ============================================================ */
export async function login(req, res, next) {
  try {
    const v = validate(loginSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const result = await authService.login(v.data);

    if (!result.ok) {
      switch (result.code) {
        case 'USER_NOT_FOUND':
          return error(
            res,
            'No account found with that email or phone number.',
            404,
            'USER_NOT_FOUND'
          );

        case 'INVALID_CREDENTIALS':
          return error(
            res,
            'Incorrect password. Please try again.',
            401,
            'INVALID_CREDENTIALS'
          );

        case 'ACCOUNT_DISABLED':
          return error(
            res,
            'Your account has been disabled. Contact support for help.',
            403,
            'ACCOUNT_DISABLED'
          );

        default:
          return error(
            res,
            result.message || 'Login failed. Please try again.',
            401,
            result.code || 'LOGIN_FAILED'
          );
      }
    }

    return success(
      res,
      { token: result.token, user: result.user },
      'Login successful'
    );
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   SET PIN
   ============================================================ */
export async function setPin(req, res, next) {
  try {
    const v = validate(setPinSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    await authService.setPin(req.user.id, v.data.pin);
    return success(res, {}, 'PIN set successfully');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   VERIFY PIN
   ============================================================ */
export async function verifyPin(req, res, next) {
  try {
    const v = validate(verifyPinSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const result = await authService.verifyPin(req.user.id, v.data.pin);
    if (!result.ok) {
      switch (result.code) {
        case 'USER_NOT_FOUND':
          return error(res, 'User not found', 404, 'USER_NOT_FOUND');
        case 'PIN_NOT_SET':
          return error(res, 'No PIN has been set for this account', 400, 'PIN_NOT_SET');
        case 'PIN_INVALID':
        default:
          return error(res, 'Incorrect PIN', 401, 'PIN_INVALID');
      }
    }

    return success(res, {}, 'PIN verified');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   GET ME
   ============================================================ */
export async function getMe(req, res, next) {
  try {
    const user = await authService.getMe(req.user.id);
    if (!user) return error(res, 'User not found', 404, 'USER_NOT_FOUND');
    return success(res, { user });
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   FORGOT PASSWORD
   ============================================================ */
export async function forgotPassword(req, res, next) {
  try {
    const v = validate(forgotPasswordSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const result = await passwordReset.requestReset({
      identifier: v.data.identifier,
      ip,
    });

    if (!result.ok) return error(res, result.message, 400, 'RESET_FAILED');

    return success(
      res,
      {},
      'If an account exists, a reset link has been sent to its email.'
    );
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   VERIFY RESET TOKEN
   ============================================================ */
export async function verifyResetToken(req, res, next) {
  try {
    const userId = String(req.body.userId || '').trim();
    const token = String(req.body.token || '').trim();

    if (!userId || !token) {
      return error(res, 'Missing userId or token', 400, 'VALIDATION_ERROR');
    }

    const result = await passwordReset.verifyResetToken({ userId, token });
    if (!result.ok) {
      const msg =
        result.code === 'TOKEN_EXPIRED'
          ? 'This reset link has expired. Please request a new one.'
          : 'This reset link is invalid.';
      return error(res, msg, 400, result.code);
    }

    return success(res, {}, 'Token is valid');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   RESET PASSWORD
   ============================================================ */
export async function resetPassword(req, res, next) {
  try {
    const v = validate(resetPasswordSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const result = await passwordReset.completeReset({
      userId: v.data.userId,
      token: v.data.token,
      newPassword: v.data.newPassword,
    });

    if (!result.ok) {
      const msg =
        result.code === 'TOKEN_EXPIRED'
          ? 'This reset link has expired. Please request a new one.'
          : 'This reset link is invalid or has already been used.';
      return error(res, msg, 400, result.code);
    }

    return success(res, {}, 'Password reset successfully. You can now log in.');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   CHANGE PASSWORD
   ============================================================ */
export async function changePassword(req, res, next) {
  try {
    const v = validate(changePasswordSchema, req.body);
    if (!v.ok) return error(res, v.message, 400, 'VALIDATION_ERROR');

    const result = await passwordReset.changePassword({
      userId: req.user.id,
      currentPassword: v.data.currentPassword,
      newPassword: v.data.newPassword,
    });

    if (!result.ok) {
      const msg =
        result.code === 'WRONG_PASSWORD'
          ? 'Current password is incorrect'
          : 'Could not change password';
      return error(res, msg, 400, result.code);
    }

    return success(res, {}, 'Password changed successfully');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   GET /auth/pin-status
   Tells the PIN page which mode to show:
     • hasPin        → VERIFY MODE (enter PIN)
     • !hasPin       → SETUP MODE  (create + confirm)
     • hasBiometric  → show fingerprint button
   ============================================================ */
export async function pinStatus(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return error(res, 'Not authenticated', 401, 'UNAUTHORIZED');

    const { rows } = await query(
      `SELECT pin_hash, biometric_credential_id
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    if (!rows.length) return error(res, 'User not found', 404, 'USER_NOT_FOUND');

    const u = rows[0];
    return success(res, {
      hasPin: !!u.pin_hash,
      hasBiometric: !!u.biometric_credential_id,
      biometricCredentialId: u.biometric_credential_id || null,
    });
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   POST /auth/verify-biometric
   WebAuthn credential-ID match.
   ============================================================ */
export async function verifyBiometric(req, res, next) {
  try {
    const userId = req.user?.id;
    const credentialId = String(req.body?.credentialId || '').trim();

    if (!userId) return error(res, 'Not authenticated', 401, 'UNAUTHORIZED');
    if (!credentialId) return error(res, 'credentialId is required', 400, 'VALIDATION_ERROR');

    const { rows } = await query(
      `SELECT biometric_credential_id
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    const stored = rows[0]?.biometric_credential_id;

    if (!stored) {
      return error(res, 'No fingerprint registered for this account', 400, 'NO_BIOMETRIC');
    }
    if (stored !== credentialId) {
      return error(res, 'Fingerprint not recognized', 400, 'BIOMETRIC_MISMATCH');
    }

    return success(res, {}, 'Fingerprint verified');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   POST /auth/register-biometric
   Called from settings to enable fingerprint unlock.
   ============================================================ */
export async function registerBiometric(req, res, next) {
  try {
    const userId = req.user?.id;
    const credentialId = String(req.body?.credentialId || '').trim();

    if (!userId) return error(res, 'Not authenticated', 401, 'UNAUTHORIZED');
    if (!credentialId) return error(res, 'credentialId is required', 400, 'VALIDATION_ERROR');

    const { rowCount } = await query(
      `UPDATE users
          SET biometric_credential_id = $1,
              biometric_registered_at = NOW(),
              updated_at = NOW()
        WHERE id = $2`,
      [credentialId, userId]
    );

    if (!rowCount) return error(res, 'User not found', 404, 'USER_NOT_FOUND');

    return success(res, {}, 'Fingerprint registered');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   POST /auth/pin-logout
   Legacy alias for /auth/logout — kept for backwards compat.
   Wipes PIN + biometric so next login forces new PIN setup.
   ============================================================ */
export async function pinLogout(req, res, next) {
  try {
    const userId = req.user?.id;

    if (userId) {
      await query(
        `UPDATE users
            SET pin_hash = NULL,
                biometric_credential_id = NULL,
                biometric_registered_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [userId]
      );
    }

    return success(res, {}, 'PIN cleared. Next login will require a new PIN.');
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   POST /auth/logout
   Canonical logout — wipes PIN + biometric on the server.
   Called by the frontend whenever the user taps "Log Out".
   ============================================================ */
export async function logout(req, res, next) {
  try {
    const userId = req.user?.id;

    if (userId) {
      await query(
        `UPDATE users
            SET pin_hash = NULL,
                biometric_credential_id = NULL,
                biometric_registered_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [userId]
      );
    }

    return success(res, {}, 'Logged out. PIN cleared.');
  } catch (err) {
    next(err);
  }
}