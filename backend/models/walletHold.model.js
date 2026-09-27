// models/walletHold.model.js
// ============================================================
// Wallet hold model — uses the real wallet_holds table
//   AND keeps wallets.held_balance in sync.
// ============================================================
import { query } from '../config/database.js';

const WalletHold = {
  /**
   * Place a hold: insert wallet_holds row + move balance → held_balance
   */
  async place(client, { userId, transactionId, amount, reference, description }) {
    const amt = Number(amount);

    // Lock wallet
    const { rows: wRows } = await client.query(
      `SELECT id, balance, held_balance FROM wallets
        WHERE user_id = $1 LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const wallet = wRows[0];
    if (!wallet) {
      throw Object.assign(new Error('Wallet not found'), { statusCode: 404, code: 'NO_WALLET' });
    }

    const balanceBefore = Number(wallet.balance || 0);
    if (balanceBefore < amt) {
      throw Object.assign(new Error('Insufficient balance'), { statusCode: 422, code: 'INSUFFICIENT' });
    }
    const balanceAfter = balanceBefore - amt;

    // Update wallet: move balance → held_balance
    await client.query(
      `UPDATE wallets
          SET balance = $2,
              held_balance = COALESCE(held_balance, 0) + $3,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [wallet.id, balanceAfter, amt]
    );

    // Insert wallet_holds row
    const { rows: holdRows } = await client.query(
      `INSERT INTO wallet_holds
         (wallet_id, transaction_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'HELD', NOW())
       RETURNING id`,
      [wallet.id, transactionId, amt]
    );

    // Ledger entry
    await client.query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, transaction_id, reference, type, direction,
          amount, balance_before, balance_after, description,
          status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'HOLD', 'DEBIT',
               $5, $6, $7, $8,
               'SUCCESS', '{}'::jsonb, NOW(), NOW())`,
      [
        wallet.id, userId, transactionId, reference,
        amt, balanceBefore, balanceAfter,
        description || 'Data purchase hold',
      ]
    );

    return { holdId: holdRows[0].id, walletId: wallet.id, amount: amt };
  },

  /**
   * Settle a hold → real debit (product delivered).
   * held_balance decreases; ledger gets DATA_PURCHASE debit.
   */
  async settle(client, { userId, transactionId, amount, reference, description }) {
    const amt = Number(amount);

    const { rows: wRows } = await client.query(
      `SELECT id, balance, held_balance FROM wallets
        WHERE user_id = $1 LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const wallet = wRows[0];
    if (!wallet) throw new Error('Wallet not found');

    const heldBefore   = Number(wallet.held_balance || 0);
    const heldAfter    = Math.max(heldBefore - amt, 0);
    const balanceNow   = Number(wallet.balance || 0);

    // Reduce held_balance only (balance already reduced at hold time)
    await client.query(
      `UPDATE wallets
          SET held_balance = $2,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [wallet.id, heldAfter]
    );

    // Mark hold DEBITED
    await client.query(
      `UPDATE wallet_holds
          SET status = 'DEBITED', updated_at = NOW()
        WHERE transaction_id = $1 AND status = 'HELD'`,
      [transactionId]
    );

    // Ledger: actual purchase debit
    await client.query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, transaction_id, reference, type, direction,
          amount, balance_before, balance_after, description,
          status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'DATA_PURCHASE', 'DEBIT',
               $5, $6, $6, $7,
               'SUCCESS', '{}'::jsonb, NOW(), NOW())`,
      [
        wallet.id, userId, transactionId, reference,
        amt, balanceNow,
        description || 'Data purchase — delivered',
      ]
    );

    return { walletId: wallet.id, amount: amt };
  },

  /**
   * Release a hold → refund to spendable balance.
   */
  async release(client, { userId, transactionId, amount, reference, description }) {
    const amt = Number(amount);

    const { rows: wRows } = await client.query(
      `SELECT id, balance, held_balance FROM wallets
        WHERE user_id = $1 LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const wallet = wRows[0];
    if (!wallet) throw new Error('Wallet not found');

    const heldBefore    = Number(wallet.held_balance || 0);
    const balanceBefore = Number(wallet.balance || 0);
    const heldAfter     = Math.max(heldBefore - amt, 0);
    const balanceAfter  = balanceBefore + amt;

    await client.query(
      `UPDATE wallets
          SET balance = $2,
              held_balance = $3,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [wallet.id, balanceAfter, heldAfter]
    );

    await client.query(
      `UPDATE wallet_holds
          SET status = 'RELEASED', updated_at = NOW()
        WHERE transaction_id = $1 AND status = 'HELD'`,
      [transactionId]
    );

    await client.query(
      `INSERT INTO wallet_ledger
         (wallet_id, user_id, transaction_id, reference, type, direction,
          amount, balance_before, balance_after, description,
          status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'HOLD_RELEASE', 'CREDIT',
               $5, $6, $7, $8,
               'SUCCESS', '{}'::jsonb, NOW(), NOW())`,
      [
        wallet.id, userId, transactionId, reference,
        amt, balanceBefore, balanceAfter,
        description || 'Hold released — refund',
      ]
    );

    return { walletId: wallet.id, amount: amt };
  },
};

export default WalletHold;