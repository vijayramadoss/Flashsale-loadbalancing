// Defence-in-depth and failure-mode tests for the flash-deal worker.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { createRedis, getRedis, keys, ORDER_GROUP, waitForRedis } from '../src/lib/redis.js';
import { reserve, getReservation } from '../src/services/reservationService.js';
import { persistReservation } from '../src/services/orderProcessor.js';
import { ensureGroup, reclaimStale } from '../src/services/orderWorker.js';
import { setup, teardown, resetData, makeDeal, drainQueue } from './helpers.js';

let app;
before(async () => {
  app = await setup();
});
after(() => teardown(app));
beforeEach(resetData);

const newUserId = () => new mongoose.Types.ObjectId().toString();

test('MongoDB conditional decrement stops overselling even if Redis admits too many', async () => {
  const deal = await makeDeal({ stock: 50 });
  // Simulate Redis drift: Mongo has only 10 units left, Redis still thinks 50.
  await Deal.updateOne({ _id: deal._id }, { remainingStock: 10, soldCount: 0 });
  for (let i = 0; i < 50; i++) await reserve(newUserId(), String(deal._id));

  await drainQueue();
  assert.equal(await Order.countDocuments({ deal: deal._id }), 10, 'DB created only what it had');
  assert.equal((await Deal.findById(deal._id)).remainingStock, 0);
  assert.equal(await getRedis().hget(keys.deal(deal._id), 'stock'), '0', 'Redis zeroed once Mongo said sold out');
});

test('failed reservations are reported with a reason', async () => {
  const deal = await makeDeal({ stock: 2 });
  await Deal.updateOne({ _id: deal._id }, { remainingStock: 1 });
  const u1 = newUserId();
  const u2 = newUserId();
  const r1 = await reserve(u1, String(deal._id));
  const r2 = await reserve(u2, String(deal._id));
  await drainQueue();
  assert.equal((await getReservation(r1.reservationId, u1)).status, 'RESERVED');
  const failed = await getReservation(r2.reservationId, u2);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.reason, 'SOLD_OUT');
});

test('processing the same queue message twice creates only one order (idempotent)', async () => {
  const deal = await makeDeal({ stock: 5 });
  const job = { reservationId: 'res-dup-1', dealId: String(deal._id), userId: newUserId(), createdAt: String(Date.now()) };
  const first = await persistReservation(job);
  const second = await persistReservation(job);
  assert.equal(first.status, 'RESERVED');
  assert.equal(second.orderId, first.orderId);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Deal.findById(deal._id)).remainingStock, 4, 'decremented once');
});

test('four concurrent transactions on the last unit: exactly one wins', async () => {
  const deal = await makeDeal({ stock: 1 });
  const jobs = [1, 2, 3, 4].map((i) => ({ reservationId: `race-${i}`, dealId: String(deal._id), userId: newUserId() }));
  const outcomes = await Promise.all(jobs.map((j) => persistReservation(j)));
  assert.equal(outcomes.filter((o) => o.status === 'RESERVED').length, 1);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Deal.findById(deal._id)).remainingStock, 0);
});

test('one customer can never hold two active orders for one deal (DB backstop)', async () => {
  const deal = await makeDeal({ stock: 5 });
  const userId = newUserId();
  const a = await persistReservation({ reservationId: 'r-a', dealId: String(deal._id), userId });
  const b = await persistReservation({ reservationId: 'r-b', dealId: String(deal._id), userId });
  assert.equal(a.status, 'RESERVED');
  assert.deepEqual(b, { status: 'FAILED', reason: 'ALREADY_PURCHASED' });
  assert.equal((await Deal.findById(deal._id)).remainingStock, 4, 'rolled back, stock untouched');
});

test('a message read by a crashed consumer is reclaimed and processed exactly once', async () => {
  const deal = await makeDeal({ stock: 3 });
  const userId = newUserId();
  const r = await reserve(userId, String(deal._id));
  await ensureGroup();
  const crashed = createRedis('crashed');
  await waitForRedis(crashed);
  const read = await crashed.xreadgroup('GROUP', ORDER_GROUP, 'crashed-consumer', 'COUNT', 10, 'STREAMS', keys.orderStream(), '>');
  assert.equal(read[0][1].length, 1);
  crashed.disconnect();
  assert.equal(await drainQueue(), 0, 'a healthy consumer does not get the in-flight message');

  assert.equal(await reclaimStale('rescuer', 0), 1);
  assert.equal((await getReservation(r.reservationId, userId)).status, 'RESERVED');
  assert.equal(await Order.countDocuments(), 1);
  const [pendingCount] = await getRedis().xpending(keys.orderStream(), ORDER_GROUP);
  assert.equal(Number(pendingCount), 0);
  assert.equal(await getRedis().xlen(keys.orderStream()), 0, 'processed messages are deleted');
});

test('if Redis loses the deal it is rebuilt from MongoDB; previous winners still cannot win twice', async () => {
  const deal = await makeDeal({ stock: 3 });
  const userId = newUserId();
  await reserve(userId, String(deal._id));
  await drainQueue();
  await getRedis().del(keys.deal(deal._id), keys.buyers(deal._id));
  const again = await reserve(userId, String(deal._id));
  assert.equal(again.duplicate, true, 'buyer list rebuilt from active orders');
  assert.equal(await getRedis().hget(keys.deal(deal._id), 'stock'), '2', 'stock rebuilt from Mongo');
});
