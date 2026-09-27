// routes/wallet.routes.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as ctrl from '../controllers/wallet.controller.js';

const router = Router();
router.use(authenticate);

/* Balance + history */
router.get('/balance',            asyncHandler(ctrl.getBalance));
router.get('/ledger',             asyncHandler(ctrl.getLedger));
router.get('/transactions',       asyncHandler(ctrl.getTransactions));
router.get('/recent-recipients',  asyncHandler(ctrl.getRecentRecipients));

/* Deposit flow */
router.post('/deposit',                asyncHandler(ctrl.createDeposit));
router.get ('/deposit/:id/status',     asyncHandler(ctrl.getDepositStatus));

/* Dev-only topup */
router.post('/topup',             asyncHandler(ctrl.topup));

export default router;