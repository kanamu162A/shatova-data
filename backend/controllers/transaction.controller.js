// controllers/transaction.controller.js
// ============================================================
// Transaction reads — user and admin
// ============================================================

import crypto from 'crypto';
import { query } from '../config/database.js';
import Transaction from '../models/transaction.model.js';

/* ============================================================
   USER — GET /transactions/me
   Paginated list of the current user's transactions.
   ============================================================ */
export async function getMyTransactions(req, res) {
  try {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const filters = {
      userId:  req.user.id,
      limit,
      offset,
      service: req.query.service ? String(req.query.service).trim() : null,
      status:  req.query.status  ? String(req.query.status).trim()  : null,
      from:    req.query.from    || null,
      to:      req.query.to      || null,
      search:  String(req.query.search || '').trim(),
    };

    const [transactions, total] = await Promise.all([
      Transaction.listForUser(filters),
      Transaction.countForUser(filters),
    ]);

    return res.json({
      success: true,
      data: { transactions, total, limit, offset },
      meta: { total, limit, offset, hasMore: offset + transactions.length < total },
    });
  } catch (err) {
    console.error('[transaction] getMyTransactions:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transactions.' });
  }
}

/* ============================================================
   USER — GET /transactions/me/:id
   Single transaction, scoped to the owner.
   ============================================================ */
export async function getMyTransaction(req, res) {
  try {
    const tx = await Transaction.findById(req.params.id, req.user.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    return res.json({ success: true, data: { transaction: tx } });
  } catch (err) {
    console.error('[transaction] getMyTransaction:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transaction.' });
  }
}

/* ============================================================
   USER — GET /transactions/recent-recipients
   Recent phone numbers the user has sent airtime/data to.
   ============================================================ */
export async function getRecentRecipients(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (metadata->>'phone')
              metadata->>'phone'                       AS phone,
              COALESCE(metadata->>'network', '')       AS network,
              COALESCE(metadata->>'network_name', '')  AS network_name,
              created_at
         FROM transactions
        WHERE user_id = $1
          AND type = 'VTU'
          AND metadata->>'phone' IS NOT NULL
        ORDER BY metadata->>'phone', created_at DESC
        LIMIT 20`,
      [req.user.id]
    );

    const sorted = rows
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8);

    return res.json({
      success: true,
      data: {
        recipients: sorted.map((r) => ({
          phone:     r.phone,
          network:   r.network,
          last_used: r.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('[transaction] getRecentRecipients:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch recipients.' });
  }
}

/* ============================================================
   ADMIN — GET /admin/transactions
   ============================================================ */
export async function adminList(req, res) {
  try {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const filters = {
      limit,
      offset,
      search:  String(req.query.search || '').trim(),
      service: req.query.service ? String(req.query.service).trim() : null,
      status:  req.query.status  ? String(req.query.status).trim()  : null,
      from:    req.query.from    || null,
      to:      req.query.to      || null,
      userId:  req.query.userId  || null,
    };

    const [transactions, total] = await Promise.all([
      Transaction.listForAdmin(filters),
      Transaction.countForAdmin(filters),
    ]);

    return res.json({
      success: true,
      data: { transactions, total, limit, offset },
      meta: { total, limit, offset, hasMore: offset + transactions.length < total },
    });
  } catch (err) {
    console.error('[transaction] adminList:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transactions.' });
  }
}

/* ============================================================
   ADMIN — GET /admin/transaction/:id
   ============================================================ */
export async function adminGet(req, res) {
  try {
    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    return res.json({ success: true, data: { transaction: tx } });
  } catch (err) {
    console.error('[transaction] adminGet:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch transaction.' });
  }
}

/* ============================================================
   ADMIN — GET /admin/transactions/stats
   ============================================================ */
export async function adminStats(req, res) {
  try {
    const stats = await Transaction.stats({
      from: req.query.from || null,
      to:   req.query.to   || null,
    });
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('[transaction] adminStats:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch stats.' });
  }
}

/* ============================================================
   WEBHOOK — POST /webhooks/transactions
   Provider callback → updates transaction status.
   ============================================================ */

const WEBHOOK_SECRET = process.env.TRANSACTION_WEBHOOK_SECRET;

/* Verify the request really came from the provider */
function verifyWebhookSignature(req) {
  if (!WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') return false;
    console.warn('[webhook] TRANSACTION_WEBHOOK_SECRET not set; skipping signature check (dev only)');
    return true;
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const signature =
    req.get('x-paystack-signature') ||
    req.get('x-webhook-signature') ||
    req.get('verif-hash') ||
    '';

  if (!signature) return false;

  const expected = crypto
    .createHmac('sha512', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Extract status from any provider payload shape */
function pickWebhookStatus(payload) {
  const raw =
    payload.status ||
    payload.event ||
    payload.data?.status ||
    payload.transaction?.status ||
    '';

  const s = String(raw).toLowerCase();

  if (['success', 'successful', 'completed', 'complete', 'delivered', 'charge.success'].some((v) => s.includes(v))) {
    return 'success';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'reversed', 'declined'].some((v) => s.includes(v))) {
    return 'failed';
  }
  if (['pending', 'processing', 'initiated', 'queued'].some((v) => s.includes(v))) {
    return 'pending';
  }
  return null;
}

/* Extract the transaction reference from any provider payload shape */
function pickWebhookReference(payload) {
  return (
    payload.reference ||
    payload.tx_ref ||
    payload.transaction_reference ||
    payload.transactionReference ||
    payload.data?.reference ||
    payload.data?.tx_ref ||
    payload.data?.transactionReference ||
    payload.transaction?.reference ||
    null
  );
}

/* ============================================================
   POST /webhooks/transactions
   Receives provider callback → updates transaction status.
   ============================================================ */
export async function transactionWebhook(req, res) {
  try {
    /* 1. Verify signature (proves it came from the provider) */
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }

    /* 2. Parse payload */
    const payload   = req.body || {};
    const reference = pickWebhookReference(payload);
    const status    = pickWebhookStatus(payload);

    /* 3. Ignore events we don't care about — but return 200 so provider stops retrying */
    if (!reference || !status) {
      return res.status(200).json({ success: true, message: 'Ignored (no reference or status)' });
    }

    /* 4. Update the transaction in the DB */
    const { rows, rowCount } = await query(
      `UPDATE transactions
          SET status     = $1,
              metadata   = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE reference = $3
           OR metadata->>'provider_reference' = $3
        RETURNING id, user_id, status, amount, type`,
      [
        status,
        JSON.stringify({ webhook: payload, webhook_at: new Date().toISOString() }),
        reference,
      ]
    );

    if (rowCount === 0) {
      console.warn('[webhook] reference not found:', reference);
      return res.status(200).json({ success: true, message: 'Reference not found, ignored' });
    }

    const tx = rows[0];
    console.log(`[webhook] tx=${tx.id} ref=${reference} status=${status}`);

    /* 5. If FAILED → refund the user's wallet (only if not already refunded) */
    if (status === 'failed') {
      try {
        await query(
          `UPDATE wallets
              SET balance = balance + $1,
                  version = version + 1,
                  updated_at = NOW()
            WHERE user_id = $2
              AND NOT EXISTS (
                SELECT 1 FROM wallet_ledger
                 WHERE transaction_id = $3
                   AND type = 'refund'
              )`,
          [tx.amount, tx.user_id, tx.id]
        );

        await query(
          `INSERT INTO wallet_ledger
             (wallet_id, user_id, transaction_id, type, amount, balance_after, status, description)
           SELECT w.id, $1, $2, 'refund', $3, w.balance, 'successful', $4
             FROM wallets w
            WHERE w.user_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM wallet_ledger
                 WHERE transaction_id = $2
                   AND type = 'refund'
              )`,
          [tx.user_id, tx.id, tx.amount, `Auto refund for failed tx ${reference}`]
        );

        console.log(`[webhook] refunded ₦${tx.amount} to user ${tx.user_id}`);
      } catch (refundErr) {
        console.error('[webhook] refund failed:', refundErr.message);
      }
    }

    /* 6. Always respond 200 so the provider knows we got it */
    return res.status(200).json({ success: true, received: true });
  } catch (err) {
    console.error('[webhook] transactionWebhook:', err);
    return res.status(500).json({ success: false, message: 'Webhook failed' });
  }
}