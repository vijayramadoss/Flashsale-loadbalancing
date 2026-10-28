// Flash deals: admission (Redis), pending order (worker), checkout, expiry.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { getRedis, keys } from '../src/lib/redis.js';
import { expireDueOrders } from '../src/services/orderService.js';
import { setup, teardown, resetData, client, makeUser, makeDeal, drainQueue, card, idem, payAndSettle } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

const reserve = (auth, dealId) => api.post(`/api/deals/${dealId}/reserve`, undefined, { auth });

test('full path: reserve (202) → worker → pending order → address → pay → CONFIRMED', async () => {
  const deal = await makeDeal({ stock: 3 });
  const u = await makeUser();

  const res = await reserve(u.auth, deal._id);
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'QUEUED');
  assert.equal(res.headers.location, res.body.trackingUrl);
  assert.equal(await Order.countDocuments(), 0, 'nothing written to Mongo on the hot path');

  assert.equal(await drainQueue(), 1);
  const tracked = await api.get(res.body.trackingUrl, { auth: u.auth });
  assert.equal(tracked.body.reservation.status, 'RESERVED');
  const orderId = tracked.body.reservation.orderId;

  const pending = await api.get(`/api/orders/${orderId}`, { auth: u.auth });
  assert.equal(pending.body.order.type, 'DEAL');
  assert.equal(pending.body.order.items[0].unitPriceCents, 1_500_000);
  assert.equal(pending.body.order.shippingAddress, null);
  assert.equal(pending.body.order.codAllowed, false);

  const noAddress = await api.post(`/api/orders/${orderId}/pay`, card(), { auth: u.auth, headers: idem() });
  assert.equal(noAddress.status, 400, 'address required before paying');

  const shipped = await api.put(`/api/orders/${orderId}/shipping`, { addressId: u.addressId, deliveryMethod: 'EXPRESS' }, { auth: u.auth });
  assert.equal(shipped.body.order.pricing.totalCents, 1_500_000 + 14_900);

  const cod = await api.post(`/api/orders/${orderId}/pay`, { method: 'COD' }, { auth: u.auth, headers: idem() });
  assert.equal(cod.status, 400, 'flash deals are prepaid only');

  const { order: paid } = await payAndSettle(api, orderId, card(), u.auth);
  assert.equal(paid.status, 'CONFIRMED');
  assert.equal((await Deal.findById(deal._id)).remainingStock, 2);
});

test('a repeat "Buy now" returns the same reservation and order', async () => {
  const deal = await makeDeal({ stock: 3 });
  const u = await makeUser();
  const first = await reserve(u.auth, deal._id);
  const again = await reserve(u.auth, deal._id);
  assert.equal(again.status, 200);
  assert.equal(again.body.reservationId, first.body.reservationId);
  await drainQueue();
  const third = await reserve(u.auth, deal._id);
  assert.equal(third.body.status, 'RESERVED');
  assert.ok(third.body.orderId);
  assert.equal(await Order.countDocuments(), 1);
});

test('deal window and stock: not started, ended, sold out → 409', async () => {
  const u = await makeUser();
  const upcoming = await makeDeal({ startsInMs: 60_000 });
  assert.equal((await reserve(u.auth, upcoming._id)).body.error.code, 'DEAL_NOT_STARTED');
  const ended = await makeDeal({ startsInMs: -120_000, durationMs: 60_000 });
  assert.equal((await reserve(u.auth, ended._id)).body.error.code, 'DEAL_ENDED');
  const one = await makeDeal({ stock: 1 });
  assert.equal((await reserve(u.auth, one._id)).status, 202);
  const late = await reserve((await makeUser()).auth, one._id);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'SOLD_OUT');
});

test('reserve requires auth, a browser-like client and a valid deal id; tracking is owner-only', async () => {
  const deal = await makeDeal();
  const u = await makeUser();
  assert.equal((await api.post(`/api/deals/${deal._id}/reserve`)).status, 401);
  assert.equal((await reserve({ ...u.auth, 'user-agent': 'curl/8.4.0' }, deal._id)).status, 403);
  assert.equal((await reserve(u.auth, 'bogus')).status, 400);
  assert.equal((await reserve(u.auth, '650000000000000000000000')).status, 404);
  const res = await reserve(u.auth, deal._id);
  assert.equal((await api.get(res.body.trackingUrl, { auth: (await makeUser()).auth })).status, 404);
});

test('per-customer rate limit on reserve answers 429 with Retry-After', async () => {
  const deal = await makeDeal();
  const u = await makeUser();
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await reserve(u.auth, deal._id)).status);
  assert.deepEqual(statuses, [202, 200, 200, 200, 200]);
  const limited = await reserve(u.auth, deal._id);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});

test('an unpaid deal order expires: the unit goes back on sale and the customer may try again', async () => {
  const deal = await makeDeal({ stock: 1 });
  const u = await makeUser();
  await reserve(u.auth, deal._id);
  await drainQueue();
  assert.equal(await getRedis().hget(keys.deal(deal._id), 'stock'), '0');
  const other = await makeUser();
  assert.equal((await reserve(other.auth, deal._id)).body.error.code, 'SOLD_OUT');

  await Order.updateOne({ deal: deal._id }, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await expireDueOrders(), 1);
  assert.equal(await getRedis().hget(keys.deal(deal._id), 'stock'), '1', 'token returned to Redis');
  assert.equal((await Deal.findById(deal._id)).remainingStock, 1, 'unit returned in Mongo');

  const second = await reserve(other.auth, deal._id);
  assert.equal(second.status, 202, 'the released unit can be won by someone else');
  await drainQueue();
  assert.equal(await Order.countDocuments({ deal: deal._id, status: 'PENDING_PAYMENT' }), 1);
});

test('admin: create a deal (validated), view consistency stats; customers are forbidden', async () => {
  const admin = await makeUser({ role: 'admin' });
  const customer = await makeUser();
  const seed = await makeDeal();
  const sku = seed.sku;
  const body = { sku, title: 'Night Deal', dealPriceCents: 1_000_000, totalStock: 50, startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() };
  assert.equal((await api.post('/api/admin/deals', body, { auth: customer.auth })).status, 403);
  assert.equal((await api.post('/api/admin/deals', { ...body, dealPriceCents: 99_000_000 }, { auth: admin.auth })).status, 400, 'deal price must be below regular price');
  assert.equal((await api.post('/api/admin/deals', { ...body, sku: 'NOPE-1-1' }, { auth: admin.auth })).status, 400);
  const created = await api.post('/api/admin/deals', body, { auth: admin.auth });
  assert.equal(created.status, 201);
  assert.equal(created.body.deal.redis.remainingTokens, 50);

  const public_ = await api.get(`/api/deals/${created.body.deal.id}`);
  assert.equal(public_.body.deal.state, 'UPCOMING');
  assert.match(public_.headers['cache-control'], /max-age=1/);
  const stats = await api.get(`/api/admin/deals/${created.body.deal.id}/stats`, { auth: admin.auth });
  assert.equal(stats.body.stats.consistency.oversold, false);
});
