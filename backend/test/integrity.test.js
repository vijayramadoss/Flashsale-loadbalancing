// Defence-in-depth and failure-mode tests for the order worker.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { FlashSale } from '../src/models/FlashSale.js';
import { Order } from '../src/models/Order.js';
import { createRedis, getRedis, keys, ORDER_GROUP, waitForRedis } from '../src/lib/redis.js';
import { reserve, getReservation } from '../src/services/checkoutService.js';
import { persistReservation } from '../src/services/orderProcessor.js';
import { ensureGroup, reclaimStale } from '../src/services/orderWorker.js';
import { setup, teardown, resetData, makeSale, drainQueue } from './helpers.js';

before(setup);
after(teardown);
beforeEach(resetData);

const newUserId = () => new mongoose.Types.ObjectId().toString();

test('MongoDB conditional decrement stops overselling even if Redis admits too many', async () => {
  const sale = await makeSale({ stock: 50 });
  // Simulate Redis drift: Mongo only has 10 units left, Redis still thinks 50.
  await FlashSale.updateOne({ _id: sale._id }, { remainingStock: 10, soldCount: 0, totalStock: 50 });

  const reservations = [];
  for (let i = 0; i < 50; i++) reservations.push(await reserve(newUserId(), String(sale._id)));
  assert.equal(reservations.length, 50);

  await drainQueue();
  assert.equal(await Order.countDocuments({ sale: sale._id }), 10, 'DB sold only what it had');
  const db = await FlashSale.findById(sale._id);
  assert.equal(db.remainingStock, 0);
  assert.ok(db.remainingStock >= 0, 'stock never negative');
  // The worker zeroes the Redis counter once Mongo reports sold out, so admission stops.
  assert.equal(await getRedis().hget(keys.sale(sale._id), 'stock'), '0');
});

test('failed reservations are reported to the client with a reason', async () => {
  const sale = await makeSale({ stock: 2 });
  await FlashSale.updateOne({ _id: sale._id }, { remainingStock: 1 });
  const u1 = newUserId();
  const u2 = newUserId();
  const r1 = await reserve(u1, String(sale._id));
  const r2 = await reserve(u2, String(sale._id));
  await drainQueue();
  assert.equal((await getReservation(r1.reservationId, u1)).status, 'CONFIRMED');
  const failed = await getReservation(r2.reservationId, u2);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.reason, 'SOLD_OUT');
});

test('processing the same queue message twice creates only one order (idempotent)', async () => {
  const sale = await makeSale({ stock: 5 });
  const job = { reservationId: 'res-dup-1', saleId: String(sale._id), userId: newUserId() };
  const first = await persistReservation(job);
  const second = await persistReservation(job);
  assert.equal(first.status, 'CONFIRMED');
  assert.equal(second.orderId, first.orderId);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await FlashSale.findById(sale._id)).remainingStock, 4, 'decremented once');
});

test('two concurrent transactions on the last unit: exactly one wins', async () => {
  const sale = await makeSale({ stock: 1 });
  const jobs = [1, 2, 3, 4].map((i) => ({ reservationId: `race-${i}`, saleId: String(sale._id), userId: newUserId() }));
  const outcomes = await Promise.all(jobs.map((j) => persistReservation(j)));
  assert.equal(outcomes.filter((o) => o.status === 'CONFIRMED').length, 1);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await FlashSale.findById(sale._id)).remainingStock, 0);
});

test('a message read by a crashed consumer is reclaimed and processed exactly once', async () => {
  const sale = await makeSale({ stock: 3 });
  const userId = newUserId();
  const r = await reserve(userId, String(sale._id));
  await ensureGroup();

  // "Crashed" consumer reads the message but dies before acknowledging it.
  const crashed = createRedis('crashed');
  await waitForRedis(crashed);
  const read = await crashed.xreadgroup('GROUP', ORDER_GROUP, 'crashed-consumer', 'COUNT', 10, 'STREAMS', keys.orderStream(), '>');
  assert.equal(read[0][1].length, 1);
  crashed.disconnect();
  assert.equal(await drainQueue(), 0, 'a healthy consumer does not get the in-flight message again');

  const reclaimed = await reclaimStale('rescuer', 0);
  assert.equal(reclaimed, 1);
  assert.equal((await getReservation(r.reservationId, userId)).status, 'CONFIRMED');
  assert.equal(await Order.countDocuments(), 1);
  const [pendingCount] = await getRedis().xpending(keys.orderStream(), ORDER_GROUP);
  assert.equal(Number(pendingCount), 0, 'acknowledged after processing');
});

test('if Redis loses the sale, it is rebuilt from MongoDB and previous buyers still cannot rebuy', async () => {
  const sale = await makeSale({ stock: 3 });
  const userId = newUserId();
  await reserve(userId, String(sale._id));
  await drainQueue();
  await getRedis().del(keys.sale(sale._id), keys.buyers(sale._id)); // simulate data loss

  const again = await reserve(userId, String(sale._id));
  assert.equal(again.duplicate, true, 'buyer list was rebuilt from orders');
  assert.equal(await getRedis().hget(keys.sale(sale._id), 'stock'), '2', 'stock rebuilt from Mongo');
});
