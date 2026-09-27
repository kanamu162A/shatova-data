// services/wallet.service.js
// ============================================================
// Wallet service — atomic, idempotent, audited
//
// 🔑 TWO DB TRIGGERS must both pass on every wallet_ledger INSERT:
//
//   1. verify_wallet_sync        → ledger.balance_after == wallets.balance
//   2. verify_ledger_continuity  → ledger.balance_before == previous
//                                    ledger row's balance_after (per wallet)
//                                  AND, for DEBIT rows:
//                                    balance_before - amount = balance_after
//                                  AND, for CREDIT rows:
//                                    balance_before + amount = balance_after
//
// 🔑 HOW WE SATISFY BOTH:
//   - holdFunds: DEBIT (balance ↓, held_balance ↑) — writes HOLD row
//                before - amount = after  ✅
//   - releaseHold: NO ledger row — money already debited at HOLD time.
//                  Just clears held_balance and marks hold RELEASED.
//   - dropHold: CREDIT (balance ↑, held_balance ↓) — writes HOLD_RELEASE row
//               before + amount = after  ✅
//   - creditWallet / debitWallet: same math rules apply
// ============================================================

import crypto from 'node:crypto';
import { withTransaction, query } from '../config/database.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function generateUniqueReference(type = 'TXN') {
  const now = new Date();
  const ymd =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const prefix = String(type).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'TXN';
  return `${prefix}-${ymd}-${rand}`;
}

async function writeAudit(client, eventType, data = {}) {
  try {
    await client.query(
      `INSERT INTO money_audit_log
         (event_type, user_id, wallet_id, reference, amount,
          balance_before, balance_after, actor, source, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        eventType,
        data.userId || null,
        data.walletId || null,
        data.reference || null,
        data.amount != null ? money(data.amount) : null,
        data.balanceBefore != null ? money(data.balanceBefore) : null,
        data.balanceAfter != null ? money(data.balanceAfter) : null,
        data.actor || 'system',
        data.source || 'service',
        JSON.stringify(data.details || {}),
      ]
    );
  } catch (err) {
    console.error('[audit] failed to write event:', eventType, err.message);
  }
}

/* Last ledger row's balance_after, for continuity */
async function getLastLedgerBalance(client, walletId) {
  const { rows } = await client.query(
    `SELECT balance_after FROM wallet_ledger
      WHERE wallet_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [walletId]
  );
  return rows[0] ? money(rows[0].balance_after) : 0;
}

/* Insert a ledger row that satisfies both triggers */
async function writeLedger(client, {
  walletId, userId, transactionId = null, reference, type, direction,
  amount, balanceBefore, balanceAfter, description,
}) {
  await client.query(
    `INSERT INTO wallet_ledger
       (wallet_id, user_id, transaction_id, reference, type, direction,
        amount, balance_before, balance_after, description,
        status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             'successful', '{}'::jsonb, NOW(), NOW())`,
    [
      walletId, userId, transactionId, reference, type, direction,
      money(amount), money(balanceBefore), money(balanceAfter), description,
    ]
  );
}

/* ============================================================
   HOLD — writes a HOLD row (DEBIT)
   Math: before - amount = after  ✅
   ============================================================ */
export async function holdFunds({ userId, amount, reference, description = 'Pending transaction' }) {
  const amt = money(amount);
  if (!amt || amt <= 0) throw new Error('Amount must be > 0.');

  return await withTransaction(async (client) => {
    /* Idempotency */
    const { rows: existing } = await client.query(
      `SELECT id, wallet_id, amount, status FROM wallet_holds
        WHERE user_id = $1 AND reference = $2
        FOR UPDATE`,
      [userId, reference]
    );
    const hold = existing.find(h => h.status === 'HELD');
    if (hold) {
      const { rows: w } = await client.query(
        `SELECT balance, held_balance FROM wallets WHERE id = $1`,
        [hold.wallet_id]
      );
      return {
        walletId:       hold.wallet_id,
        balance_before: money(Number(w[0].balance) + Number(hold.amount)),
        balance_after:  money(Number(w[0].balance)),
        held_after:     money(Number(w[0].held_balance)),
        amount:         money(Number(hold.amount)),
        idempotent:     true,
      };
    }

    /* Lock wallet */
    const { rows: w } = await client.query(
      `SELECT id, balance, held_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const wallet = w[0];
    if (!wallet) throw new Error('Wallet not found.');

    const before = money(wallet.balance);
    const held   = money(wallet.held_balance);

    if (before < amt) {
      const err = new Error('Insufficient balance.');
      err.code = 'INSUFFICIENT_BALANCE';
      err.data = { balance: before, required: amt, shortfall: money(amt - before) };
      throw err;
    }

    const after     = money(before - amt);
    const heldAfter = money(held + amt);

    /* 1. Update wallet (balance ↓, held_balance ↑) */
    await client.query(
      `UPDATE wallets
          SET balance = $1, held_balance = $2,
              version = version + 1, updated_at = NOW()
        WHERE id = $3`,
      [after, heldAfter, wallet.id]
    );

    /* 2. Insert wallet_holds row */
    await client.query(
      `INSERT INTO wallet_holds (wallet_id, user_id, reference, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'HELD', NOW())`,
      [wallet.id, userId, reference, amt]
    );

    /* 3. Write HOLD ledger row (satisfies both triggers) */
    await writeLedger(client, {
      walletId: wallet.id,
      userId,
      reference,
      type: 'HOLD',
      direction: 'DEBIT',
      amount: amt,
      balanceBefore: before,
      balanceAfter: after,
      description,
    });

    await writeAudit(client, 'hold_placed', {
      userId, walletId: wallet.id, reference, amount: amt,
      balanceBefore: before, balanceAfter: after,
      source: 'holdFunds',
      details: { description, held_after: heldAfter },
    });

    return {
      walletId:       wallet.id,
      balance_before: before,
      balance_after:  after,
      held_after:     heldAfter,
      amount:         amt,
      idempotent:     false,
    };
  });
}

/* ============================================================
   RELEASE — finalise a purchase
   ------------------------------------------------------------
   The money was already removed from wallets.balance at HOLD time
   (a DEBIT ledger row was written then).
   Release just:
     - clears held_balance
     - marks the hold RELEASED
   NO new ledger row — the "spend" was already recorded as HOLD.
   ============================================================ */
export async function releaseHold({ userId, reference, transactionId = null, description = 'Purchase' }) {
  return await withTransaction(async (client) => {
    /* Find any hold for this reference */
    const { rows: hRows } = await client.query(
      `SELECT id, wallet_id, amount, status FROM wallet_holds
        WHERE reference = $1 AND user_id = $2
        ORDER BY id ASC FOR UPDATE`,
      [reference, userId]
    );

    const activeHold = hRows.find(h => h.status === 'HELD');

    /* Nothing to do if already released */
    if (!activeHold) {
      const anyHold = hRows[0];
      return {
        released:   true,
        amount:     anyHold ? money(anyHold.amount) : 0,
        idempotent: true,
        reason:     'already_settled_or_no_hold',
      };
    }

    const walletId = activeHold.wallet_id;
    const amt      = money(activeHold.amount);

    const { rows: w } = await client.query(
      `SELECT balance, held_balance FROM wallets WHERE id = $1 FOR UPDATE`,
      [walletId]
    );
    const balanceNow = money(w[0].balance);
    const held       = money(w[0].held_balance);
    const heldAfter  = Math.max(0, money(held - amt));

    /* Clear held_balance only — balance was already reduced at HOLD */
    await client.query(
      `UPDATE wallets
          SET held_balance = $1, version = version + 1, updated_at = NOW()
        WHERE id = $2`,
      [heldAfter, walletId]
    );

    /* Mark the hold RELEASED */
    await client.query(
      `UPDATE wallet_holds
          SET status = 'RELEASED', resolved_at = NOW()
        WHERE id = $1`,
      [activeHold.id]
    );

    /* ⭐ NO ledger insert — money already recorded as a HOLD debit. */

    await writeAudit(client, 'hold_released', {
      userId, walletId, reference, amount: amt,
      balanceBefore: balanceNow, balanceAfter: balanceNow,
      source: 'releaseHold',
      details: { description, transactionId, held_after: heldAfter },
    });

    return {
      released:      true,
      amount:        amt,
      ledger_before: balanceNow,
      ledger_after:  balanceNow,
      idempotent:    false,
    };
  });
}

/* ============================================================
   DROP — cancel, refund to available
   Math: before + amount = after  ✅
   ============================================================ */
export async function dropHold({ userId, reference }) {
  return await withTransaction(async (client) => {
    const { rows: hRows } = await client.query(
      `SELECT id, wallet_id, amount, status FROM wallet_holds
        WHERE reference = $1 AND user_id = $2 AND status = 'HELD'
        ORDER BY id ASC FOR UPDATE`,
      [reference, userId]
    );
    const hold = hRows[0];
    if (!hold) return { skipped: true, reason: 'no_active_hold' };

    const walletId = hold.wallet_id;
    const amt      = money(hold.amount);

    const { rows: w } = await client.query(
      `SELECT balance, held_balance FROM wallets WHERE id = $1 FOR UPDATE`,
      [walletId]
    );
    const before    = money(w[0].balance);
    const held      = money(w[0].held_balance);
    const after     = money(before + amt);
    const heldAfter = Math.max(0, money(held - amt));

    /* Refund: balance ↑, held_balance ↓ */
    await client.query(
      `UPDATE wallets
          SET balance = $1, held_balance = $2,
              version = version + 1, updated_at = NOW()
        WHERE id = $3`,
      [after, heldAfter, walletId]
    );

    await client.query(
      `UPDATE wallet_holds SET status = 'DROPPED', resolved_at = NOW() WHERE id = $1`,
      [hold.id]
    );

    /* Ledger row — CREDIT refund */
    await writeLedger(client, {
      walletId,
      userId,
      reference,
      type: 'HOLD_RELEASE',
      direction: 'CREDIT',
      amount: amt,
      balanceBefore: before,
      balanceAfter:  after,
      description: 'Hold released — refund',
    });

    await writeAudit(client, 'hold_dropped', {
      userId, walletId, reference, amount: amt,
      balanceBefore: before, balanceAfter: after,
      source: 'dropHold',
      details: { held_after: heldAfter },
    });

    return { dropped: true, amount: amt, balance_after: after };
  });
}

/* ============================================================
   CREDIT — Math: before + amount = after  ✅
   ============================================================ */
export async function creditWallet({
  userId, amount, reference,
  type = 'WALLET_TOPUP',
  description = 'Wallet credit',
  transactionId = null,
}) {
  const amt = money(amount);
  if (!amt || amt <= 0) throw new Error('Amount must be > 0.');

  const ref = String(reference || generateUniqueReference(type)).trim();

  return await withTransaction(async (client) => {
    /* Idempotency */
    const { rows: existing } = await client.query(
      `SELECT id, amount, balance_before, balance_after FROM wallet_ledger
        WHERE user_id = $1 AND reference = $2 AND type = $3 LIMIT 1 FOR UPDATE`,
      [userId, ref, type]
    );
    if (existing.length) {
      return {
        before:    money(existing[0].balance_before),
        after:     money(existing[0].balance_after),
        amount:    money(existing[0].amount),
        reference: ref,
        walletId:  null,
        idempotent: true,
      };
    }

    const { rows: w } = await client.query(
      `SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!w[0]) throw new Error('Wallet not found.');

    /* Read from LEDGER for continuity, then verify against wallet */
    const ledgerBefore = await getLastLedgerBalance(client, w[0].id);
    const after        = money(ledgerBefore + amt);

    /* Align wallet to ledger before crediting */
    await client.query(
      `UPDATE wallets SET balance = $1, version = version + 1, updated_at = NOW() WHERE id = $2`,
      [after, w[0].id]
    );

    await writeLedger(client, {
      walletId: w[0].id,
      userId,
      transactionId,
      reference: ref,
      type,
      direction: 'CREDIT',
      amount: amt,
      balanceBefore: ledgerBefore,
      balanceAfter:  after,
      description,
    });

    await writeAudit(client, 'credit', {
      userId, walletId: w[0].id, reference: ref, amount: amt,
      balanceBefore: ledgerBefore, balanceAfter: after,
      source: 'creditWallet', details: { type, description },
    });

    return { before: ledgerBefore, after, amount: amt, reference: ref, idempotent: false };
  });
}

/* ============================================================
   DEBIT — Math: before - amount = after  ✅
   ============================================================ */
export async function debitWallet({
  userId, amount, reference,
  type = 'DEBIT',
  description = 'Wallet debit',
  transactionId = null,
}) {
  const amt = money(amount);
  if (!amt || amt <= 0) throw new Error('Amount must be > 0.');

  const ref = String(reference || generateUniqueReference(type)).trim();

  return await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id, amount, balance_before, balance_after FROM wallet_ledger
        WHERE user_id = $1 AND reference = $2 AND type = $3 LIMIT 1 FOR UPDATE`,
      [userId, ref, type]
    );
    if (existing.length) {
      return {
        before:    money(existing[0].balance_before),
        after:     money(existing[0].balance_after),
        amount:    money(existing[0].amount),
        reference: ref,
        walletId:  null,
        idempotent: true,
      };
    }

    const { rows: w } = await client.query(
      `SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!w[0]) throw new Error('Wallet not found.');

    const ledgerBefore = await getLastLedgerBalance(client, w[0].id);
    if (ledgerBefore < amt) {
      const err = new Error('Insufficient balance.');
      err.code = 'INSUFFICIENT_BALANCE';
      err.data = { balance: ledgerBefore, required: amt, shortfall: money(amt - ledgerBefore) };
      throw err;
    }
    const after = money(ledgerBefore - amt);

    await client.query(
      `UPDATE wallets SET balance = $1, version = version + 1, updated_at = NOW() WHERE id = $2`,
      [after, w[0].id]
    );

    await writeLedger(client, {
      walletId: w[0].id,
      userId,
      transactionId,
      reference: ref,
      type,
      direction: 'DEBIT',
      amount: amt,
      balanceBefore: ledgerBefore,
      balanceAfter:  after,
      description,
    });

    await writeAudit(client, 'debit', {
      userId, walletId: w[0].id, reference: ref, amount: amt,
      balanceBefore: ledgerBefore, balanceAfter: after,
      source: 'debitWallet', details: { type, description },
    });

    return { before: ledgerBefore, after, amount: amt, reference: ref, idempotent: false };
  });
}

/* ============================================================
   GETTERS
   ============================================================ */
export async function getWallet(userId) {
  const { rows } = await query(
    `SELECT id, balance, held_balance, status, daily_limit, daily_spent, daily_reset_at
       FROM wallets WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

export async function ensureWallet(userId) {
  const existing = await getWallet(userId);
  if (existing) return existing;

  const { rows } = await query(
    `INSERT INTO wallets
       (user_id, balance, held_balance, status, daily_limit, daily_spent, daily_reset_at, version)
     VALUES ($1, 0, 0, 'ACTIVE', 200000, 0, NOW(), 0)
     ON CONFLICT (user_id) DO NOTHING RETURNING *`,
    [userId]
  );
  if (rows.length) return rows[0];
  return await getWallet(userId);
}