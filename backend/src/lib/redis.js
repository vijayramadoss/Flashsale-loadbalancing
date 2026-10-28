import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from './logger.js';
import { defineScripts } from '../redis/scripts.js';

// Keys are built explicitly (instead of ioredis' keyPrefix option) so it is
// obvious which key each Lua script touches. `p` namespaces all keys.
const p = () => config.redisPrefix;
export const keys = {
  sale: (saleId) => `${p()}sale:${saleId}`,
  buyers: (saleId) => `${p()}sale:${saleId}:buyers`,
  reservation: (reservationId) => `${p()}res:${reservationId}`,
  orderStream: () => `${p()}orders:stream`,
  rateLimit: (bucket, id) => `${p()}rl:${bucket}:${id}`,
};

export const ORDER_GROUP = 'order-writers';

export function createRedis(name = 'main') {
  const client = new Redis(config.redisUrl, {
    // Reject commands quickly when Redis is down instead of queueing them
    // in memory — under a traffic spike a growing offline queue would eat RAM.
    enableOfflineQueue: name !== 'main',
    maxRetriesPerRequest: 2,
    connectionName: `flashsale-${name}-${process.pid}`,
  });
  client.on('error', (err) => logger.error('redis error', { name, err: err.message }));
  defineScripts(client);
  return client;
}

let shared;
export function getRedis() {
  if (!shared) shared = createRedis('main');
  return shared;
}

export async function waitForRedis(client = getRedis()) {
  if (client.status === 'ready') return client;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
    client.once('ready', () => { clearTimeout(timer); resolve(); });
  });
  return client;
}

export async function closeRedis() {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
