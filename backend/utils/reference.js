// utils/reference.js
import crypto from 'crypto';

/**
 * Unique transaction reference.
 * Length: 20 chars (provider requires 15–40)
 * Example: TXN-7A3F12B8-K2N9XZ4
 */
export function generateReference(prefix = 'TXN') {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  const time = Date.now().toString(36).toUpperCase();
  return `${prefix}-${rand}-${time}`;
}