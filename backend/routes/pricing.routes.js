// routes/pricing.routes.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as ctrl from '../controllers/pricing.controller.js';

const router = Router();

router.use(authenticate);

/* ── Existing DataShop reference endpoints (unchanged) ── */
router.get ('/datashop', asyncHandler(ctrl.getDatashopPricing));
router.post('/refresh',  asyncHandler(ctrl.forceRefreshPricing));
router.get ('/debug',    asyncHandler(ctrl.debugDatashop));   // ← temporary

/* ── NEW: data_plans list + per-plan price update ── */
router.get ('/data-plans',            asyncHandler(ctrl.getDataPlans));
router.patch('/data-plans/:plan_id',  asyncHandler(ctrl.updateDataPlan));

export default router;
