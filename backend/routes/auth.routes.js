// routes/auth.routes.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  register,
  login,
  setPin,
  verifyPin,
  getMe,
  forgotPassword,
  verifyResetToken,
  resetPassword,
  changePassword,

  pinStatus,
  verifyBiometric,
  pinLogout,
  registerBiometric,
  logout,
} from '../controllers/auth.controller.js';

const router = Router();

/* ─── Public ─────────────────────────────────────────────── */
router.post('/register',            asyncHandler(register));
router.post('/login',               asyncHandler(login));
router.post('/forgot-password',     asyncHandler(forgotPassword));
router.post('/verify-reset-token',  asyncHandler(verifyResetToken));
router.post('/reset-password',      asyncHandler(resetPassword));

/* ─── Authenticated ──────────────────────────────────────── */
router.get ('/me',                  authenticate, asyncHandler(getMe));
router.post('/set-pin',             authenticate, asyncHandler(setPin));
router.post('/verify-pin',          authenticate, asyncHandler(verifyPin));
router.post('/change-password',     authenticate, asyncHandler(changePassword));

/* ─── PIN + fingerprint ──────────────────────────────────── */
router.get ('/pin-status',          authenticate, asyncHandler(pinStatus));
router.post('/verify-biometric',    authenticate, asyncHandler(verifyBiometric));
router.post('/register-biometric',  authenticate, asyncHandler(registerBiometric));
router.post('/pin-logout',          authenticate, asyncHandler(pinLogout));

/* ─── Logout (canonical) ─────────────────────────────────── */
router.post('/logout',              authenticate, asyncHandler(logout));

export default router;