import axios from 'axios';
import crypto from 'node:crypto';
import { env } from '../env/env.js';

const BASE_URL = env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com';
let tokenCache = { token: null, expiresAt: 0 };

function credentials() {
  if (!env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY || !env.MONNIFY_CONTRACT_CODE) {
    const err = new Error('Monnify is not configured.'); err.code = 'MONNIFY_NOT_CONFIGURED'; throw err;
  }
}

async function getAccessToken() {
  credentials();
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const basic = Buffer.from(env.MONNIFY_API_KEY + ':' + env.MONNIFY_SECRET_KEY).toString('base64');
  const response = await axios.post(BASE_URL + '/api/v1/auth/login', {}, { headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' }, timeout: 15000 });
  const data = response.data;
  const token = data?.responseBody?.accessToken;
  if (!token) throw new Error(data?.responseMessage || 'Monnify authentication failed.');
  tokenCache = { token, expiresAt: Date.now() + Number(data.responseBody.expiresIn || 3600) * 1000 };
  return token;
}

export async function createReservedAccount({ accountReference, accountName, customerEmail, customerName, bvn, nin }) {
  if (!bvn && !nin) { const err = new Error('BVN or NIN is required to create a virtual account.'); err.code = 'KYC_REQUIRED'; throw err; }
  const token = await getAccessToken();
  const payload = { accountReference, accountName, currencyCode: 'NGN', contractCode: env.MONNIFY_CONTRACT_CODE, customerEmail, customerName, getAllAvailableBanks: true, ...(bvn ? { bvn } : {}), ...(nin ? { nin } : {}) };
  try {
    const response = await axios.post(BASE_URL + '/api/v2/bank-transfer/reserved-accounts', payload, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 20000 });
    const data = response.data;
    if (!data?.requestSuccessful) { const err = new Error(data?.responseMessage || 'Could not create virtual account.'); err.code = 'MONNIFY_API_ERROR'; throw err; }
    return data.responseBody;
  } catch (err) {
    if (err.response?.data) { const e = new Error(err.response.data?.responseMessage || err.response.data?.message || 'Monnify request failed.'); e.code = 'MONNIFY_API_ERROR'; e.status = err.response.status; throw e; }
    throw err;
  }
}

export function verifyWebhookSignature(rawBody, signature) {
  const secret = env.MONNIFY_SECRET_KEY || '';
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8'); const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
