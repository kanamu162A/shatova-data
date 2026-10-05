import { query } from '../config/database.js';
import { createReservedAccount } from '../services/monnify.service.js';
import { ensureWallet } from '../services/wallet.service.js';

function accountReferenceFor(userId) { return 'SHATOVA-' + String(userId); }
function cleanKyc(value) { return String(value || '').replace(/\D/g, ''); }

export async function getVirtualAccount(req, res) {
  const result = await query('SELECT account_reference, account_name, bank_name, account_number, currency, status, provider, created_at FROM virtual_accounts WHERE user_id = $1 LIMIT 1', [req.user.id]);
  return res.json({ success: true, data: result.rows[0] || null });
}

export async function createVirtualAccount(req, res) {
  try {
    const existing = await query('SELECT account_reference, account_name, bank_name, account_number, currency, status, provider, created_at FROM virtual_accounts WHERE user_id = $1 LIMIT 1', [req.user.id]);
    if (existing.rows[0]) return res.json({ success: true, data: existing.rows[0], existing: true });
    const bvn = cleanKyc(req.body?.bvn); const nin = cleanKyc(req.body?.nin);
    if (!bvn && !nin) return res.status(422).json({ success: false, code: 'KYC_REQUIRED', message: 'Enter your BVN or NIN to create your Shatova funding account.' });
    if (bvn && bvn.length !== 11) return res.status(422).json({ success: false, message: 'BVN must be 11 digits.' });
    if (nin && nin.length !== 11) return res.status(422).json({ success: false, message: 'NIN must be 11 digits.' });
    await ensureWallet(req.user.id);
    const customerName = String(req.user.name || '').trim(); const customerEmail = String(req.user.email || '').trim().toLowerCase();
    const provider = await createReservedAccount({ accountReference: accountReferenceFor(req.user.id), accountName: customerName || 'Shatova User ' + req.user.id, customerEmail, customerName: customerName || customerEmail, bvn: bvn || undefined, nin: nin || undefined });
    const account = provider?.accounts?.[0];
    if (!account?.accountNumber) throw new Error('Monnify did not return a virtual account number.');
    const sql = 'INSERT INTO virtual_accounts (user_id, account_reference, reservation_reference, account_name, bank_code, bank_name, account_number, currency, status, provider, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,\'NGN\',$8,\'MONNIFY\',NOW(),NOW()) ON CONFLICT (user_id) DO NOTHING RETURNING account_reference, account_name, bank_name, account_number, currency, status, provider, created_at';
    const inserted = await query(sql, [req.user.id, provider.accountReference || accountReferenceFor(req.user.id), provider.reservationReference || null, provider.accountName || customerName, account.bankCode || null, account.bankName || null, account.accountNumber, provider.status || 'ACTIVE']);
    const data = inserted.rows[0] || (await query('SELECT account_reference, account_name, bank_name, account_number, currency, status, provider, created_at FROM virtual_accounts WHERE user_id = $1', [req.user.id])).rows[0];
    return res.status(201).json({ success: true, message: 'Your Shatova funding account is ready.', data });
  } catch (err) {
    console.error('[virtual-account] create:', err);
    return res.status(err.code === 'KYC_REQUIRED' ? 422 : (err.status || 500)).json({ success: false, code: err.code || 'VIRTUAL_ACCOUNT_ERROR', message: err.message || 'Could not create your funding account.' });
  }
}
