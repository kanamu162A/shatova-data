import { verifyToken } from '../utils/jwt.js';
import { error } from '../utils/response.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return error(res, 'Authentication required', 401, 'NO_TOKEN');
  }

  const token = header.slice(7).trim();

  try {
    const decoded = verifyToken(token);
    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Session expired. Please log in again.', 401, 'TOKEN_EXPIRED');
    }
    return error(res, 'Invalid token', 401, 'INVALID_TOKEN');
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return error(res, 'Admin access required', 403, 'FORBIDDEN');
  }
  next();
}