import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getVirtualAccount, createVirtualAccount } from '../controllers/virtualAccount.controller.js';
const router = Router();
router.use(authenticate);
router.get('/', asyncHandler(getVirtualAccount));
router.post('/', asyncHandler(createVirtualAccount));
export default router;
