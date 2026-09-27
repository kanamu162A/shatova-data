// routes/airtime.routes.js
import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  getNetworks,
  getProducts,
  getConfig,
  getBalance,
  getTransactionStatus,
  purchase,
} from '../controllers/airtime.controller.js';
import { getRecentRecipients } from '../controllers/wallet.controller.js';

const router = express.Router();

router.use(authenticate);

router.get('/networks',          getNetworks);
router.get('/products',          getProducts);
router.get('/config',            getConfig);
router.get('/balance',           getBalance);
router.get('/status',            getTransactionStatus);
router.get('/recent-recipients', getRecentRecipients);
router.post('/purchase',         purchase);

export default router;