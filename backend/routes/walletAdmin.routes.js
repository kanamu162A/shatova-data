// routes/walletAdmin.routes.js
import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as ctrl from '../controllers/walletAdmin.controller.js';

const router = Router();
router.use(authenticate, requireAdmin);

/* Deposits */
router.get ('/deposits/all',         asyncHandler(ctrl.getDeposits));
router.get ('/deposits',             asyncHandler(ctrl.getDeposits));
router.get ('/deposit/:id',          asyncHandler(ctrl.getDeposit));
router.post('/deposit/:id/approve',  asyncHandler(ctrl.approveDeposit));
router.post('/deposit/:id/reject',   asyncHandler(ctrl.rejectDeposit));

/* Withdrawals */
router.get ('/withdrawals/all',          asyncHandler(ctrl.getWithdrawals));
router.get ('/withdrawals',              asyncHandler(ctrl.getWithdrawals));
router.get ('/withdrawal/:id',           asyncHandler(ctrl.getWithdrawal));
router.post('/withdrawal/:id/approve',   asyncHandler(ctrl.approveWithdrawal));
router.post('/withdrawal/:id/reject',    asyncHandler(ctrl.rejectWithdrawal));

export default router;
