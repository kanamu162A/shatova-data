import express from 'express';
import { monnifyWebhook, monnifyWebhookHealth } from '../controllers/monnifyWebhook.controller.js';
const router = express.Router();
router.post('/monnify', monnifyWebhook);
router.get('/monnify', monnifyWebhookHealth);
export default router;
