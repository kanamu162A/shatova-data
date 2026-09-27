// routes/webhook.routes.js
// ============================================================
// DataShop webhook routes
//   ⚠ Global express.json({ verify }) in server.js already
//     populates req.rawBody — do NOT re-parse here.
// ============================================================
import express from 'express';
import {
  datashopWebhook,
  datashopWebhookHealth,
} from '../controllers/webhook.controller.js';

const router = express.Router();

router.post('/datashop', datashopWebhook);
router.get('/datashop', datashopWebhookHealth);

export default router;