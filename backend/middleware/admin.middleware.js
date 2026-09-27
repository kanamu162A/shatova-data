// middleware/admin.middleware.js
// ============================================================
// Shatova — Admin role guard
//   • Named export:  requireAdmin
//   • Default export: { requireAdmin, isAdminRole }
//   • Role check is case-insensitive and tolerant of spacing
// ============================================================

const ADMIN_ROLES = ['admin', 'super_admin', 'superadmin', 'owner'];

export function isAdminRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return ADMIN_ROLES.includes(r);
}

/**
 * Middleware — requires the authenticated user to have an admin role.
 * Must run AFTER `authenticate` so `req.user` is populated.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  const role = req.user.role || req.user.userRole || req.user.user_role || '';
  if (!isAdminRole(role)) {
    return res.status(403).json({
      success: false,
      message: 'Admin access required',
      code:    'NOT_ADMIN',
    });
  }

  next();
}

export default { requireAdmin, isAdminRole };