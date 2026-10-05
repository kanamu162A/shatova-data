import crypto from 'node:crypto';
import { query } from '../config/database.js';
import { creditWallet } from '../services/wallet.service.js';
import { verifyWebhookSignature } from '../services/monnify.service.js';

export async function monnifyWebhook(req, res) {
  const signature = req.headers['monnify-signature'];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  if (!verifyWebhookSignature(rawBody, signature)) return res.status(401).json({ success: false, message: 'Invalid signature' });

  res.status(200).json({ success: true, received: true });
  const body = req.body || {};
  const event = body.eventType;
  const data = body.eventData || {};
  if (event !== 'SUCCESSFUL_TRANSACTION' || data.paymentStatus !== 'PAID') return;
  if (data.product?.type !== 'RESERVED_ACCOUNT') return;

  try {
    const accountReference = data.product?.reference;
    const accountNumber = data.destinationAccountInformation?.accountNumber;
    const providerReference = data.transactionReference || data.paymentReference;
    const amount = Number(data.amountPaid);
    if (!providerReference || !amount || amount <= 0) return;

    const accountResult = await query('SELECT id, user_id, account_reference, account_number, status FROM virtual_accounts WHERE account_reference = $1 OR account_number = $2 LIMIT 1', [accountReference || '', accountNumber || '']);
    const account = accountResult.rows[0];
    if (!account || String(account.status).toUpperCase() !== 'ACTIVE') return;

    const reference = 'VA-' + providerReference.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
    const existing = await query('SELECT id FROM transactions WHERE reference = $1 LIMIT 1', [reference]);
    let transactionId = existing.rows[0]?.id || null;
    if (!transactionId) {
      const tx = await query('INSERT INTO transactions (user_id, reference, type, service, amount, status, provider_reference, metadata, description, created_at, updated_at) VALUES ($1,$2,\'FUNDING\',\'WALLET\',$3,\'PROCESSING\',$4,$5::jsonb,$6,NOW(),NOW()) RETURNING id', [account.user_id, reference, amount, providerReference, JSON.stringify({ provider: 'MONNIFY', account_reference: account.account_reference, payment_reference: data.paymentReference || null }), 'Wallet funding via Shatova virtual account']);
      transactionId = tx.rows[0]?.id;
    }

    await creditWallet({ userId: account.user_id, amount, reference, type: 'FUNDING', description: 'Wallet funded via Shatova virtual account', transactionId });
    await query('UPDATE transactions SET status = \'SUCCESS\', provider_reference = $1, updated_at = NOW() WHERE reference = $2', [providerReference, reference]);
    await query('INSERT INTO virtual_account_payments (virtual_account_id, user_id, provider_transaction_reference, payment_reference, amount, currency, payer_name, payer_account_number, payer_bank_code, status, raw_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'SUCCESS\',$10::jsonb) ON CONFLICT (provider_transaction_reference) DO NOTHING', [account.id, account.user_id, providerReference, data.paymentReference || null, amount, data.currency || 'NGN', data.paymentSourceInformation?.[0]?.accountName || null, data.paymentSourceInformation?.[0]?.accountNumber || null, data.paymentSourceInformation?.[0]?.bankCode || null, JSON.stringify(body)]);
    console.log('[monnify] wallet funded:', account.user_id, amount, providerReference);
  } catch (err) {
    console.error('[monnify] webhook processing failed:', err);
  }
}

export async function monnifyWebhookHealth(req, res) { res.json({ success: true, service: 'Shatova Monnify Webhook', status: 'listening' }); }
