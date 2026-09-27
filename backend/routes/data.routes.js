// routes/data.routes.js
import express from 'express';
import * as dataController from '../controllers/data.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

router.get('/networks',   dataController.getNetworks);
router.get('/categories', dataController.getCategories);
router.get('/bundles',    dataController.getBundles);
router.post('/verify-customer', dataController.verifyCustomer);
router.post('/purchase', dataController.purchase);
router.get('/status',    dataController.getStatus);

export default router;