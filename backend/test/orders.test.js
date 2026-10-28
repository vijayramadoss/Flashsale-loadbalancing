// Cart checkout: place order → pay (simulated gateway) → ship → deliver, plus
// declines, idempotency, cancellation, hold expiry and ownership.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Product } from '../src/models/Product.js';
import { Order } from '../src/models/Order.js';
import { expireDueOrders } from '../src/services/orderService.js';
import { setup, teardown, resetData, client, makeUser, makeProduct, card, idem } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

const stockOf = async (sku) => (await Product.findOne({ 'variants.sku': sku })).variants.find((v) => v.sku === sku).stock;

async function placeOrder(qty = 2, deliveryMethod = 'STANDARD') {
  const p = await makeProduct({ stock: 5, priceCents: 1_000_000, mrpCents: 1_100_000 });
  const u = await makeUser();
  const sku = p.variants[0].sku;
  const res = await api.post('/api/orders', { items: [{ sku, qty }], addressId: u.addressId, deliveryMethod }, { auth: u.auth });
  return { ...u, sku, res, order: res.body.order };
}

test('placing an order holds stock, snapshots the address and prices server-side', async () => {
  const { res, order, sku } = await placeOrder(2, 'EXPRESS');
  assert.equal(res.status, 201);
  assert.equal(order.status, 'PENDING_PAYMENT');
  assert.match(order.orderNumber, /^FS\d{6}-[0-9A-F]{6}$/);
  assert.equal(order.shippingAddress.city, 'Bengaluru');
  assert.deepEqual(order.pricing, { subtotalCents: 2_000_000, savingsCents: 200_000, deliveryCents: 14_900, totalCents: 2_014_900 });
  assert.ok(new Date(order.expiresAt) > new Date());
  assert.equal(await stockOf(sku), 3, 'stock decremented at placement');
  assert.equal(order.canPay, true);
});

test('an order that cannot be fully fulfilled is rejected and nothing is decremented', async () => {
  const p = await makeProduct({ stock: 1 });
  const u = await makeUser();
  const [a, b] = p.variants;
  // Second line asks for more than exists → CART_CHANGED, first line must not be decremented either.
  const res = await api.post('/api/orders', { items: [{ sku: b.sku, qty: 1 }, { sku: a.sku, qty: 3 }], addressId: u.addressId }, { auth: u.auth });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CART_CHANGED');
  assert.equal(await stockOf(a.sku), 1);
  assert.equal(await stockOf(b.sku), 1);
  assert.equal(await Order.countDocuments(), 0);
});

test('card payment confirms the order; only brand + last4 are stored', async () => {
  const { order, auth } = await placeOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'CONFIRMED');
  assert.equal(res.body.order.payment.status, 'PAID');
  assert.equal(res.body.order.payment.last4, '4242');
  const raw = JSON.stringify(await Order.findById(order.id).lean());
  assert.doesNotMatch(raw, /4242424242424242/);
  assert.doesNotMatch(raw, /"cvc"/);
});

test('a declined card leaves the order payable and records the attempt', async () => {
  const { order, auth } = await placeOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, card('4000000000000002'), { auth, headers: idem() });
  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'CARD_DECLINED');
  const after = await api.get(`/api/orders/${order.id}`, { auth });
  assert.equal(after.body.order.status, 'PENDING_PAYMENT');
  assert.equal(after.body.order.payment.failedAttempts, 1);
  const retry = await api.post(`/api/orders/${order.id}/pay`, { method: 'UPI', upi: { vpa: 'asha@okbank' } }, { auth, headers: idem() });
  assert.equal(retry.body.order.status, 'CONFIRMED');
  assert.equal(retry.body.order.payment.vpa, 'as***@okbank');
});

test('payments are idempotent: same key replays, a different key cannot pay twice', async () => {
  const { order, auth } = await placeOrder();
  const key = idem();
  const [a, b] = await Promise.all([
    api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: key }),
    api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: key }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.order.payment.paidAt, b.body.order.payment.paidAt);
  const other = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'ALREADY_PAID');
  assert.equal((await api.post(`/api/orders/${order.id}/pay`, card(), { auth })).status, 400, 'Idempotency-Key is required');
});

test('cash on delivery confirms a cart order without charging', async () => {
  const { order, auth } = await placeOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, { method: 'COD' }, { auth, headers: idem() });
  assert.equal(res.body.order.status, 'CONFIRMED');
  assert.equal(res.body.order.payment.status, 'COD');
});

test('cancelling returns the stock; a paid order is marked refunded', async () => {
  const { order, auth, sku } = await placeOrder(2);
  await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  const res = await api.post(`/api/orders/${order.id}/cancel`, undefined, { auth });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'CANCELLED');
  assert.equal(res.body.order.payment.status, 'REFUNDED');
  assert.equal(await stockOf(sku), 5);
  assert.equal((await api.post(`/api/orders/${order.id}/cancel`, undefined, { auth })).status, 409, 'cannot cancel twice');
});

test('unpaid orders expire after the hold and their stock is released; paying late is refused', async () => {
  const { order, auth, sku } = await placeOrder(2);
  await Order.updateOne({ _id: order.id }, { expiresAt: new Date(Date.now() - 1000) });
  const late = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ORDER_EXPIRED');
  assert.equal(await expireDueOrders(), 1);
  assert.equal(await expireDueOrders(), 0, 'sweeping again is a no-op');
  assert.equal((await Order.findById(order.id)).status, 'EXPIRED');
  assert.equal(await stockOf(sku), 5);
});

test('customers only see their own orders; admins move orders through fulfilment', async () => {
  const { order, auth } = await placeOrder();
  const other = await makeUser();
  assert.equal((await api.get(`/api/orders/${order.id}`, { auth: other.auth })).status, 404);
  assert.equal((await api.post(`/api/orders/${order.id}/pay`, card(), { auth: other.auth, headers: idem() })).status, 404);
  const mine = await api.get('/api/orders', { auth });
  assert.equal(mine.body.orders.length, 1);

  const admin = await makeUser({ role: 'admin' });
  assert.equal((await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth: admin.auth })).status, 409, 'unpaid cannot ship');
  await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal((await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth: auth })).status, 403);
  const shipped = await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth: admin.auth });
  assert.equal(shipped.body.order.status, 'SHIPPED');
  assert.equal(shipped.body.order.canCancel, false);
  const delivered = await api.post(`/api/admin/orders/${order.id}/status`, { status: 'DELIVERED' }, { auth: admin.auth });
  assert.equal(delivered.body.order.status, 'DELIVERED');
  const list = await api.get('/api/admin/orders?status=DELIVERED', { auth: admin.auth });
  assert.equal(list.body.orders.length, 1);
  assert.equal(list.body.orders[0].customer.name, 'Test User');
});
