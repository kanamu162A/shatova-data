import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { initializeFunding, verifyFunding } from '../controllers/paystack.controller.js';

const router = Router();
router.use(authenticate);
router.post('/initialize', asyncHandler(initializeFunding));
router.get('/verify/:reference', asyncHandler(verifyFunding));

export default router;
