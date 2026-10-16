import crypto from 'node:crypto';
import { query, withTransaction } from '../config/database.js';
import { creditWallet } from '../services/wallet.service.js';
import * as paystack from '../services/paystack.service.js';
import { env } from '../env/env.js';

const MIN_NAIRA = 100;
const MAX_NAIRA = 500000;

function makeReference() {
  return `SHATOVA-${Date.now()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function publicError(err, res) {
  console.error('[paystack]', err.message);
  const status = err.code === 'PAYSTACK_NOT_CONFIGURED' ? 503 : (err.statusCode || 500);
  return res.status(status).json({
    success: false,
    message: status === 500 ? 'Payment service is temporarily unavailable.' : err.message,
  });
}

export async function initializeFunding(req, res) {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_NAIRA || amount > MAX_NAIRA) {
      return res.status(422).json({ success: false, message: `Enter a whole-naira amount from ₦${MIN_NAIRA} to ₦${MAX_NAIRA.toLocaleString()}.` });
    }

    const { rows: users } = await query(
      'SELECT id, email FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    if (!users[0]?.email) {
      return res.status(422).json({ success: false, message: 'Add and verify your email before funding your wallet.' });
    }

    const reference = makeReference();
    const amountKobo = amount * 100;
    const callbackUrl = env.PAYSTACK_CALLBACK_URL || `${env.FRONTEND_URL.replace(/\/$/, '')}/fund-wallet.html`;

    // Create intent before contacting Paystack so every checkout is auditable.
    await query(
      `INSERT INTO paystack_payment_intents (user_id, reference, amount_kobo, status)
       VALUES ($1, $2, $3, 'pending')`,
      [req.user.id, reference, amountKobo]
    );

    const checkout = await paystack.initializeTransaction({
      email: users[0].email,
      amountKobo,
      reference,
      callbackUrl,
      metadata: { user_id: String(req.user.id), purpose: 'shatova_wallet_funding' },
    });

    await query(
      `UPDATE paystack_payment_intents
          SET access_code = $1, checkout_url = $2, updated_at = NOW()
        WHERE reference = $3 AND user_id = $4`,
      [checkout.access_code, checkout.authorization_url, reference, req.user.id]
    );

    return res.status(201).json({
      success: true,
      data: { reference, amount, currency: 'NGN', authorization_url: checkout.authorization_url },
    });
  } catch (err) {
    return publicError(err, res);
  }
}

export async function verifyFunding(req, res) {
  try {
    const reference = String(req.params.reference || '');
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(reference)) {
      return res.status(400).json({ success: false, message: 'Invalid payment reference.' });
    }
    const { rows } = await query(
      `SELECT reference, amount_kobo, status FROM paystack_payment_intents
        WHERE reference = $1 AND user_id = $2 LIMIT 1`,
      [reference, req.user.id]
    );
    const intent = rows[0];
    if (!intent) return res.status(404).json({ success: false, message: 'Payment not found.' });

    const verified = await paystack.verifyTransaction(reference);
    if (verified.status !== 'success' ||
        verified.currency !== 'NGN' ||
        Number(verified.amount) !== Number(intent.amount_kobo) ||
        verified.reference !== reference) {
      return res.status(409).json({ success: true, data: { reference, status: intent.status }, message: 'Payment is not confirmed yet.' });
    }

    await settleVerifiedPayment(reference, verified);
    const { rows: updated } = await query(
      'SELECT status, amount_kobo, paid_at FROM paystack_payment_intents WHERE reference = $1 AND user_id = $2',
      [reference, req.user.id]
    );
    return res.json({ success: true, data: { reference, status: updated[0]?.status, amount: Number(updated[0]?.amount_kobo) / 100, paid_at: updated[0]?.paid_at } });
  } catch (err) {
    return publicError(err, res);
  }
}

async function settleVerifiedPayment(reference, verified) {
  if (verified.status !== 'success' || verified.currency !== 'NGN' || verified.reference !== reference) {
    throw new Error('Verified payment does not match the payment intent.');
  }

  // Serialize concurrent webhook and browser-verification attempts by locking
  // the intent row. The wallet credit has its own idempotency reference as a
  // second safety barrier. If the intent update fails after crediting, a retry
  // finds the existing ledger credit and does not add money a second time.
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, amount_kobo, status
         FROM paystack_payment_intents
        WHERE reference = $1
        FOR UPDATE`,
      [reference]
    );
    const intent = rows[0];
    if (!intent) throw new Error('Payment intent not found.');
    if (Number(verified.amount) !== Number(intent.amount_kobo)) {
      throw new Error('Verified payment amount does not match the payment intent.');
    }
    if (intent.status === 'success') return;

    await creditWallet({
      userId: intent.user_id,
      amount: Number(intent.amount_kobo) / 100,
      reference: `PAYSTACK-${reference}`,
      type: 'WALLET_TOPUP',
      description: 'Wallet funding via Paystack',
    });

    await client.query(
      `UPDATE paystack_payment_intents
          SET status = 'success',
              provider_transaction_id = $1,
              paid_at = COALESCE(paid_at, NOW()),
              updated_at = NOW()
        WHERE reference = $2 AND status <> 'success'`,
      [Number(verified.id), reference]
    );
  });
}

export async function paystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];
  if (!paystack.verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
  }

  const event = req.body || {};
  const reference = event?.data?.reference;
  const eventKey = `paystack:${event.event || 'unknown'}:${reference || crypto.createHash('sha256').update(req.rawBody).digest('hex')}`;

  try {
    // Record delivery; unique event key makes repeated deliveries auditable.
    await query(
      `INSERT INTO paystack_webhook_events (event_key, event_type, reference, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_key) DO NOTHING`,
      [eventKey, String(event.event || 'unknown'), reference || null, JSON.stringify(event)]
    );

    if (event.event === 'charge.success' && reference) {
      // Never trust webhook amount/status alone: verify against Paystack API.
      const verified = await paystack.verifyTransaction(String(reference));
      if (verified.reference === reference && verified.status === 'success') {
        await settleVerifiedPayment(String(reference), verified);
      }
    }

    await query('UPDATE paystack_webhook_events SET processed_at = COALESCE(processed_at, NOW()) WHERE event_key = $1', [eventKey]);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[paystack webhook]', err.message);
    // Non-2xx allows provider retry; idempotent credit protects repeated delivery.
    return res.status(500).json({ received: false });
  }
}
