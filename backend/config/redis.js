import { createClient } from 'redis';
import { env } from '../env/env.js';

let client = null;
let ready = false;

if (env.hasRedis) {
  client = createClient({ url: env.REDIS_URL });
  client.on('error', (err) => {
    if (ready) console.warn('Redis error:', err.message);
  });
}

export async function connectRedis() {
  if (!client) {
    console.log('Redis not configured - cache disabled');
    return;
  }
  try {
    await client.connect();
    ready = true;
    console.log('Redis connected');
  } catch (err) {
    console.warn('Redis unavailable:', err.message);
  }
}

export function isRedisReady() {
  return ready && client && client.isOpen;
}

export const cache = {
  async get(key) {
    if (!isRedisReady()) return null;
    try { return await client.get(key); } catch { return null; }
  },
  async set(key, value, opts) {
    if (!isRedisReady()) return;
    try { await client.set(key, value, opts); } catch {}
  },
  async del(key) {
    if (!isRedisReady()) return;
    try { await client.del(key); } catch {}
  },
};