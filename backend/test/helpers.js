// Shared test fixtures. Tests run against REAL MongoDB and Redis (as the app
// does), isolated by a separate database name and Redis DB index + key prefix.
import mongoose from 'mongoose';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, createRedis, getRedis, waitForRedis } from '../src/lib/redis.js';
import { User } from '../src/models/User.js';
import { Product } from '../src/models/Product.js';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { signToken } from '../src/services/authService.js';
import { createDeal, clearDealListCache } from '../src/services/dealService.js';
import { ensureGroup, processBatch } from '../src/services/orderWorker.js';
import { buildApp } from '../src/app.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FlashSaleTest/1.0';

// Hard guard so a misconfigured run can never wipe development data.
if (!config.isTest || !/_test\b|_test\?/.test(config.mongoUri) || !config.redisPrefix.startsWith('fstest')) {
  throw new Error('Refusing to run tests: load backend/.env.test (npm test does this)');
}

let blocking;

export async function setup() {
  await connectMongo();
  await waitForRedis(getRedis());
  // syncIndexes also drops indexes left over from older schema versions.
  for (const m of [User, Product, Deal, Order]) await m.syncIndexes();
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function teardown(app) {
  await app?.close();
  blocking?.disconnect();
  blocking = undefined;
  await closeRedis();
  await disconnectMongo();
}

export async function resetData() {
  await Promise.all([User.deleteMany({}), Product.deleteMany({}), Deal.deleteMany({}), Order.deleteMany({})]);
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${config.redisPrefix}*`, 'COUNT', 500);
    if (found.length) await redis.del(...found);
    cursor = next;
  } while (cursor !== '0');
  clearDealListCache();
}

/** Small wrapper over app.inject that returns { status, body, headers }. */
export function client(app) {
  const call = async (method, url, { auth, body, headers = {} } = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: { 'user-agent': UA, ...(auth || {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = res.json(); } catch { /* empty body */ }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  };
  return {
    get: (url, opts) => call('GET', url, opts),
    post: (url, body, opts = {}) => call('POST', url, { ...opts, body }),
    put: (url, body, opts = {}) => call('PUT', url, { ...opts, body }),
    del: (url, opts) => call('DELETE', url, opts),
  };
}

export async function makeUser({ role = 'customer', name = 'Test User', email, withAddress = true } = {}) {
  const user = await User.create({
    name,
    email: email || `user-${new mongoose.Types.ObjectId()}@example.test`,
    passwordHash: 'not-a-real-hash',
    role,
    addresses: withAddress
      ? [{ label: 'Home', fullName: 'Test User', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', isDefault: true }]
      : [],
  });
  return { user, addressId: user.addresses[0]?._id.toString(), auth: { authorization: `Bearer ${signToken(user)}` } };
}

/** Synthetic buyer: a valid JWT for a fresh ObjectId, no DB write (for big concurrency tests). */
export function syntheticBuyer() {
  const user = { _id: new mongoose.Types.ObjectId(), role: 'customer', name: 'Load Buyer' };
  return { id: user._id.toString(), auth: { authorization: `Bearer ${signToken(user)}`, 'user-agent': UA } };
}

let productSeq = 0;
export async function makeProduct({ stock = 10, priceCents = 2_000_000, mrpCents = 2_200_000, brand = 'TestBrand', name } = {}) {
  productSeq++;
  return Product.create({
    slug: `test-phone-${productSeq}`,
    brand,
    name: name || `Test Phone ${productSeq}`,
    tagline: 'A phone for tests',
    variants: [
      { sku: `TP${productSeq}-8-128-BLA`, color: 'Black', colorHex: '#111111', storage: '128 GB', ram: '8 GB', priceCents, mrpCents, stock },
      { sku: `TP${productSeq}-8-256-WHI`, color: 'White', colorHex: '#eeeeee', storage: '256 GB', ram: '8 GB', priceCents: priceCents + 500_000, mrpCents: mrpCents + 500_000, stock },
    ],
    rating: 4,
    ratingCount: productSeq * 10,
    releaseYear: 2025,
  });
}

export async function makeDeal({ stock = 10, startsInMs = -1000, durationMs = 3_600_000, dealPriceCents = 1_500_000, holdMinutes = 10 } = {}) {
  const product = await makeProduct();
  const startsAt = new Date(Date.now() + startsInMs);
  return createDeal({
    sku: product.variants[0].sku,
    title: 'Test Deal',
    dealPriceCents,
    totalStock: stock,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    holdMinutes,
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

export const card = (number = '4242424242424242') => ({ method: 'CARD', card: { number, expiry: '12/30', cvc: '123', name: 'Test User' } });
export const idem = () => ({ 'idempotency-key': `test-${new mongoose.Types.ObjectId()}` });
