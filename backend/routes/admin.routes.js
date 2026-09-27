// routes/admin.routes.js
// ============================================================
// Shatova — Admin Routes
//   ⭐ Matches the actual exports in admin.controller.js
//   ⭐ Now includes dashboard, manual fund/debit, archive,
//     mismatches, and wallet drift endpoints
//   ⭐ Protected by BOTH authenticate + requireAdmin
// ============================================================

import express from 'express';
import * as adminController from '../controllers/admin.controller.js';
import * as adminPricing    from '../controllers/adminPricing.controller.js';
import { authenticate }     from '../middleware/auth.middleware.js';
import { requireAdmin }     from '../middleware/admin.middleware.js';

const router = express.Router();

/* Every /admin/* route requires:
     1. a valid JWT (authenticate)
     2. an admin role (requireAdmin) */
router.use(authenticate);
router.use(requireAdmin);

/* ── DASHBOARD ─────────────────────────────────────────────── */
router.get('/dashboard',          adminController.getDashboard);

/* ── USERS ─────────────────────────────────────────────────── */
router.get('/users',              adminController.getUsers);
router.get('/users/:id',          adminController.getUser);
router.patch('/users/:id/role',   adminController.updateUserRole);

/* ── TRANSACTIONS ──────────────────────────────────────────── */
router.get('/transactions',            adminController.getTransactions);
router.get('/transactions/archived',   adminController.listArchivedTransactions);
router.post('/transactions/archive',   adminController.triggerArchive);
router.get('/transaction/:id',         adminController.getTransaction);

/* ── STATS ─────────────────────────────────────────────────── */
router.get('/stats',              adminController.getStats);

/* ── DATASHOP WALLET ───────────────────────────────────────── */
router.get('/datashop/wallet',    adminController.getDatashopWallet);

/* ── WALLET (MANUAL FUND / DEBIT / LOOKUP / DRIFT) ─────────── */
router.post('/wallet/fund',       adminController.manualFund);
router.post('/wallet/debit',      adminController.manualDebit);
router.get ('/wallet/lookup',     adminController.lookupUser);
router.get ('/wallet/drift',      adminController.listWalletDrift);

/* ── ADMIN ACTIONS LOG ─────────────────────────────────────── */
router.get ('/actions',           adminController.listActions);
router.get ('/actions/stats',     adminController.fundingStats);

/* ── MISMATCHES (from audit) ───────────────────────────────── */
router.get ('/mismatches',             adminController.listMismatches);
router.post('/mismatches/:id/resolve', adminController.resolveMismatch);

/* ── DATA PLAN PRICING (used by /pricing.html) ─────────────── */
router.get  ('/data-plans',         adminPricing.listDataPlans);
router.patch('/data-plans/:planId', adminPricing.updateDataPlan);
router.post ('/data-plans/bulk',    adminPricing.bulkUpdatePrices);

export default router;