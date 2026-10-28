// Shared test fixtures. Tests run against REAL MongoDB and Redis (as the app
// does), isolated by a separate database name and Redis DB index + key prefix.
import mongoose from 'mongoose';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, createRedis, getRedis, waitForRedis } from '../src/lib/redis.js';
import { User } from '../src/models/User.js';
import { Product } from '../src/models/Product.js';
import { FlashSale } from '../src/models/FlashSale.js';
import { Order } from '../src/models/Order.js';
import { signToken } from '../src/services/authService.js';
import { createSale, clearSaleListCache } from '../src/services/saleService.js';
import { ensureGroup, processBatch } from '../src/services/orderWorker.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FlashSaleTest/1.0';

// Hard guard so a misconfigured run can never wipe development data.
if (!config.isTest || !/_test\b|_test\?/.test(config.mongoUri) || !config.redisPrefix.startsWith('fstest')) {
  throw new Error('Refusing to run tests: load backend/.env.test (npm test does this)');
}

let blocking;

export async function setup() {
  await connectMongo();
  await waitForRedis(getRedis());
  await Promise.all([User.init(), Product.init(), FlashSale.init(), Order.init()]);
}

export async function teardown() {
  blocking?.disconnect();
  blocking = undefined;
  await closeRedis();
  await disconnectMongo();
}

export async function resetData() {
  await Promise.all([User.deleteMany({}), Product.deleteMany({}), FlashSale.deleteMany({}), Order.deleteMany({})]);
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${config.redisPrefix}*`, 'COUNT', 500);
    if (found.length) await redis.del(...found);
    cursor = next;
  } while (cursor !== '0');
  clearSaleListCache();
}

export async function makeUser({ role = 'customer', name = 'Test User', email } = {}) {
  const user = await User.create({
    name,
    email: email || `user-${new mongoose.Types.ObjectId()}@example.test`,
    passwordHash: 'not-a-real-hash',
    role,
  });
  return { user, token: signToken(user), auth: { Authorization: `Bearer ${signToken(user)}`, 'User-Agent': UA } };
}

/** Synthetic buyer: a valid JWT for a fresh ObjectId, no DB round-trip (for big concurrency tests). */
export function syntheticBuyer() {
  const user = { _id: new mongoose.Types.ObjectId(), role: 'customer', name: 'Load Buyer' };
  return { id: user._id.toString(), auth: { Authorization: `Bearer ${signToken(user)}`, 'User-Agent': UA } };
}

export async function makeSale({ stock = 10, startsInMs = -1000, durationMs = 3_600_000, priceCents = 1000 } = {}) {
  const startsAt = new Date(Date.now() + startsInMs);
  return createSale({
    title: 'Test Sale',
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    totalStock: stock,
    product: { name: 'Test Phone', description: '', imageUrl: '', priceCents, currency: 'INR' },
  });
}

/** Runs the real order-worker code until the stream has no new messages. */
export async function drainQueue(consumer = 'test-consumer') {
  if (!blocking) {
    blocking = createRedis('test-blocking');
    await waitForRedis(blocking);
  }
  await ensureGroup();
  let total = 0;
  for (;;) {
    const n = await processBatch(blocking, consumer, { blockMs: 50, count: 100 });
    if (n === 0) return total;
    total += n;
  }
}
