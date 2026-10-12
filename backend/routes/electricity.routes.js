// routes/electricity.routes.js
import express from 'express';
import * as ctrl from '../controllers/electricity.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

router.get('/products', ctrl.getProducts);
router.get('/history',  ctrl.getHistory);
router.post('/verify',  ctrl.verifyMeter);
router.post('/purchase', ctrl.purchase);
router.get('/status',   ctrl.getStatus);

export default router;
