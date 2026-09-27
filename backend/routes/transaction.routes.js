// routes/transaction.routes.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as ctrl from '../controllers/transaction.controller.js';

const router = Router();

/* ============================================================
   PUBLIC — Webhook (no auth — providers can't send JWTs)
   MUST be before router.use(authenticate)
   ============================================================ */
router.post('/webhooks/transactions', asyncHandler(ctrl.transactionWebhook));

/* ============================================================
   AUTHENTICATED — everything below requires a logged-in user
   ============================================================ */
router.use(authenticate);

router.get('/me',                 asyncHandler(ctrl.getMyTransactions));
router.get('/me/:id',             asyncHandler(ctrl.getMyTransaction));
router.get('/recent-recipients',  asyncHandler(ctrl.getRecentRecipients));

export default router;