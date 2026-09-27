// utils/jwt.js
// ============================================================
// JWT helpers — sign & verify
// ============================================================

import jwt from 'jsonwebtoken';
import { env } from '../env/env.js';

export function signToken(payload, expiresIn = env.JWT_EXPIRES_IN) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

export default { signToken, verifyToken };