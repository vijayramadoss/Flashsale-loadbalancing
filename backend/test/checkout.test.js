import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FlashSale } from '../src/models/FlashSale.js';
import { Order } from '../src/models/Order.js';
import { setup, teardown, resetData, makeUser, makeSale, drainQueue } from './helpers.js';

const app = createApp();
const checkout = (auth, saleId) => request(app).post('/api/checkout').set(auth).send({ saleId: String(saleId) });

before(setup);
after(teardown);
beforeEach(resetData);

test('full happy path: 202 + tracking URL → worker → CONFIRMED order in MongoDB', async () => {
  const sale = await makeSale({ stock: 3 });
  const { auth, user } = await makeUser();

  const res = await checkout(auth, sale._id);
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'QUEUED');
  assert.equal(res.headers.location, res.body.trackingUrl);
  assert.equal(res.headers['retry-after'], '1');

  // Before the worker runs: still queued, nothing in MongoDB yet (write path is decoupled).
  const queued = await request(app).get(res.body.trackingUrl).set(auth);
  assert.equal(queued.body.reservation.status, 'QUEUED');
  assert.equal(await Order.countDocuments(), 0);

  assert.equal(await drainQueue(), 1);

  const done = await request(app).get(res.body.trackingUrl).set(auth);
  assert.equal(done.body.reservation.status, 'CONFIRMED');
  assert.ok(done.body.reservation.orderId);

  const order = await Order.findById(done.body.reservation.orderId);
  assert.equal(order.user.toString(), user._id.toString());
  assert.equal((await FlashSale.findById(sale._id)).remainingStock, 2);

  const mine = await request(app).get('/api/orders/mine').set(auth);
  assert.equal(mine.body.orders.length, 1);
  assert.equal(mine.body.orders[0].productName, 'Test Phone');
});

test('a repeat click returns the SAME reservation (200), never a second one', async () => {
  const sale = await makeSale({ stock: 3 });
  const { auth } = await makeUser();
  const first = await checkout(auth, sale._id);
  const second = await checkout(auth, sale._id);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.reservationId, first.body.reservationId);
  await drainQueue();
  assert.equal(await Order.countDocuments(), 1);
  // After confirmation, retrying still points at the same (now CONFIRMED) reservation.
  const third = await checkout(auth, sale._id);
  assert.equal(third.body.status, 'CONFIRMED');
});

test('sale window is enforced: not started → 409, ended → 409', async () => {
  const { auth } = await makeUser();
  const upcoming = await makeSale({ startsInMs: 60_000 });
  const r1 = await checkout(auth, upcoming._id);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error.code, 'SALE_NOT_STARTED');

  const ended = await makeSale({ startsInMs: -120_000, durationMs: 60_000 });
  const r2 = await checkout(auth, ended._id);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error.code, 'SALE_ENDED');
});

test('sold out → 409 SOLD_OUT once the stock is gone', async () => {
  const sale = await makeSale({ stock: 1 });
  const a = await makeUser();
  const b = await makeUser();
  assert.equal((await checkout(a.auth, sale._id)).status, 202);
  const res = await checkout(b.auth, sale._id);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SOLD_OUT');
});

test('checkout requires auth, a browser-like client and a valid sale id', async () => {
  const sale = await makeSale();
  const { auth } = await makeUser();
  assert.equal((await request(app).post('/api/checkout').set('User-Agent', auth['User-Agent']).send({ saleId: String(sale._id) })).status, 401);
  assert.equal((await checkout({ ...auth, 'User-Agent': 'curl/8.4.0' }, sale._id)).status, 403);
  assert.equal((await checkout({ ...auth, 'User-Agent': '' }, sale._id)).status, 403);
  assert.equal((await checkout(auth, 'bogus')).status, 400);
  assert.equal((await checkout(auth, '650000000000000000000000')).status, 404);
});

test('users cannot see each other\'s reservations', async () => {
  const sale = await makeSale();
  const alice = await makeUser();
  const bob = await makeUser();
  const res = await checkout(alice.auth, sale._id);
  const peek = await request(app).get(res.body.trackingUrl).set(bob.auth);
  assert.equal(peek.status, 404);
});

test('per-user checkout rate limit answers 429 with Retry-After', async () => {
  const sale = await makeSale();
  const { auth } = await makeUser();
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await checkout(auth, sale._id)).status);
  assert.deepEqual(statuses, [202, 200, 200, 200, 200]);
  const limited = await checkout(auth, sale._id);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});
