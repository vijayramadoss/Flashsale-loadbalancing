// Cart checkout: place order → pay through the (simulated) gateway → webhook
// confirms → ship → deliver; plus declines, idempotency, cancellation + refund,
// hold expiry and ownership.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Product } from '../src/models/Product.js';
import { Order } from '../src/models/Order.js';
import { Payment } from '../src/models/Payment.js';
import { expireDueOrders } from '../src/services/orderService.js';
import { setup, teardown, resetData, client, makeUser, makeProduct, card, idem, payAndSettle, waitFor } from './helpers.js';

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
  assert.deepEqual(order.pricing, { subtotalCents: 2_000_000, savingsCents: 200_000, couponDiscountCents: 0, deliveryCents: 14_900, totalCents: 2_014_900 });
  assert.equal(await stockOf(sku), 3, 'stock decremented at placement');
  assert.equal(order.canPay, true);
});

test('an order that cannot be fully fulfilled is rejected and nothing is decremented', async () => {
  const p = await makeProduct({ stock: 1 });
  const u = await makeUser();
  const [a, b] = p.variants;
  const res = await api.post('/api/orders', { items: [{ sku: b.sku, qty: 1 }, { sku: a.sku, qty: 3 }], addressId: u.addressId }, { auth: u.auth });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CART_CHANGED');
  assert.equal(await stockOf(a.sku), 1);
  assert.equal(await stockOf(b.sku), 1);
  assert.equal(await Order.countDocuments(), 0);
});

test('card payment: 202 PROCESSING → signed webhook → CAPTURED + order CONFIRMED with an invoice; only brand + last4 stored', async () => {
  const { order, auth } = await placeOrder();
  const { res, payment, order: paid } = await payAndSettle(api, order.id, card(), auth);
  assert.equal(res.status, 202);
  assert.equal(res.body.payment.status, 'PROCESSING');
  assert.equal(res.headers.location, `/api/payments/${res.body.payment.id}`);
  assert.equal(payment.status, 'CAPTURED');
  assert.equal(paid.status, 'CONFIRMED');
  assert.equal(paid.payment.status, 'PAID');
  assert.equal(paid.payment.last4, '4242');
  // The invoice number is assigned right after confirmation (separate step keeps numbering gap-free).
  const invoiced = await waitFor(async () => (await Order.findById(order.id)).invoice?.number);
  assert.match(invoiced, /^INV-\d{4}-\d{6}$/);
  const raw = JSON.stringify([await Order.findById(order.id).lean(), await Payment.find().lean()]);
  assert.doesNotMatch(raw, /4242424242424242/);
  assert.doesNotMatch(raw, /"cvc"/);
});

test('a bank decline arrives by webhook; the order stays payable and a retry by UPI succeeds', async () => {
  const { order, auth } = await placeOrder();
  const declined = await payAndSettle(api, order.id, card('4000000000000002'), auth);
  assert.equal(declined.payment.status, 'FAILED');
  assert.equal(declined.payment.failureCode, 'CARD_DECLINED');
  assert.equal(declined.order.status, 'PENDING_PAYMENT');
  assert.equal(declined.order.payment.failedAttempts, 1);
  assert.equal(declined.order.canPay, true);
  const retry = await payAndSettle(api, order.id, { method: 'UPI', upi: { vpa: 'asha@okbank' } }, auth);
  assert.equal(retry.order.status, 'CONFIRMED');
  assert.equal(retry.order.payment.vpa, 'as***@okbank');
});

test('format errors are rejected synchronously (402) without contacting the bank', async () => {
  const { order, auth } = await placeOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, card('1234567812345678'), { auth, headers: idem() });
  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'INVALID_CARD');
  assert.equal((await api.get(`/api/orders/${order.id}`, { auth })).body.order.payment.failedAttempts, 1);
});

test('payments are idempotent: same key → same payment; a second attempt while processing is refused', async () => {
  const { order, auth } = await placeOrder();
  const key = idem();
  const [a, b] = await Promise.all([
    api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: key }),
    api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: key }),
  ]);
  const ids = new Set([a, b].filter((r) => r.body.payment).map((r) => r.body.payment.id));
  assert.equal(ids.size, 1, 'one payment for one key');
  const other = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.ok([409].includes(other.status), 'a different attempt cannot start while one is processing');
  await waitFor(async () => (await Order.findById(order.id)).status === 'CONFIRMED');
  assert.equal(await Payment.countDocuments({ order: order.id }), 1, 'charged once');
  const late = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal(late.body.error.code, 'ALREADY_PAID');
  assert.equal((await api.post(`/api/orders/${order.id}/pay`, card(), { auth })).status, 400, 'Idempotency-Key is required');
});

test('cash on delivery confirms a cart order without the gateway', async () => {
  const { order, auth } = await placeOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, { method: 'COD' }, { auth, headers: idem() });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'CONFIRMED');
  assert.equal(res.body.order.payment.status, 'COD');
  assert.ok(res.body.order.invoice.number);
});

test('cancelling a paid order returns the stock and refunds through the gateway (refund webhook)', async () => {
  const { order, auth, sku } = await placeOrder(2);
  await payAndSettle(api, order.id, card(), auth);
  const res = await api.post(`/api/orders/${order.id}/cancel`, undefined, { auth });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'CANCELLED');
  assert.equal(res.body.order.payment.status, 'REFUND_PENDING');
  assert.equal(await stockOf(sku), 5);
  await waitFor(async () => (await Order.findById(order.id)).payment.status === 'REFUNDED');
  assert.equal((await Payment.findOne({ order: order.id })).status, 'REFUNDED');
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
  assert.equal((await api.get('/api/orders', { auth })).body.orders.length, 1);

  const admin = await makeUser({ role: 'admin' });
  assert.equal((await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth: admin.auth })).status, 409, 'unpaid cannot ship');
  await payAndSettle(api, order.id, card(), auth);
  assert.equal((await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth })).status, 403);
  const shipped = await api.post(`/api/admin/orders/${order.id}/status`, { status: 'SHIPPED' }, { auth: admin.auth });
  assert.equal(shipped.body.order.status, 'SHIPPED');
  assert.equal(shipped.body.order.canCancel, false);
  const delivered = await api.post(`/api/admin/orders/${order.id}/status`, { status: 'DELIVERED' }, { auth: admin.auth });
  assert.equal(delivered.body.order.status, 'DELIVERED');
  assert.equal(delivered.body.order.canReturn, true);
  const list = await api.get('/api/admin/orders?status=DELIVERED', { auth: admin.auth });
  assert.equal(list.body.orders[0].customer.name, 'Test User');
});
