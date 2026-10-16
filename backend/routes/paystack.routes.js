import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { initializeFunding, verifyFunding, paystackWebhook } from '../controllers/paystack.controller.js';

const router = Router();
// Public endpoint; controller verifies Paystack's HMAC signature over rawBody.
router.post('/webhook', asyncHandler(paystackWebhook));
router.use(authenticate);
router.post('/initialize', asyncHandler(initializeFunding));
router.get('/verify/:reference', asyncHandler(verifyFunding));

export default router;
