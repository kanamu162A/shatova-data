import crypto from 'node:crypto';
import { env } from '../env/env.js';

const API_BASE = 'https://api.paystack.co';

function secretKey() {
  if (!env.PAYSTACK_SECRET_KEY) {
    const err = new Error('Paystack is not configured.');
    err.code = 'PAYSTACK_NOT_CONFIGURED';
    throw err;
  }
  if (env.NODE_ENV === 'production' && !env.PAYSTACK_SECRET_KEY.startsWith('sk_live_')) {
    const err = new Error('Live Paystack key is required in production.');
    err.code = 'PAYSTACK_LIVE_KEY_REQUIRED';
    throw err;
  }
  if (env.NODE_ENV !== 'production' && !env.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
    const err = new Error('Use a Paystack test secret key outside production.');
    err.code = 'PAYSTACK_TEST_KEY_REQUIRED';
    throw err;
  }
  return env.PAYSTACK_SECRET_KEY;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== true) {
    const err = new Error(payload.message || `Paystack request failed (${response.status}).`);
    err.code = 'PAYSTACK_API_ERROR';
    err.statusCode = response.status >= 500 ? 502 : 400;
    throw err;
  }
  return payload.data;
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  let key;
  try { key = secretKey(); } catch { return false; }
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest();
  let received;
  try { received = Buffer.from(String(signature), 'hex'); } catch { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  return request('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountKobo,
      currency: 'NGN',
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });
}

export function verifyTransaction(reference) {
  return request(`/transaction/verify/${encodeURIComponent(reference)}`);
}
