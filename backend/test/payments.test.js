// Gateway integration: webhook security, at-least-once delivery, late captures,
// and reconciliation when a webhook never arrives.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Order } from '../src/models/Order.js';
import { Payment } from '../src/models/Payment.js';
import { WebhookEvent } from '../src/models/WebhookEvent.js';
import { signWebhook, setWebhookDeliverer } from '../src/services/gateway/simulatorGateway.js';
import { reconcilePayments } from '../src/services/paymentEvents.js';
import { verifySignature } from '../src/routes/webhooks.js';
import { setup, teardown, resetData, client, makeUser, makeProduct, card, idem, waitFor, sleep } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

const injectDeliverer = async (body, headers) => (await app.inject({ method: 'POST', url: '/api/webhooks/gateway', payload: body, headers })).statusCode;

async function pendingOrder() {
  const p = await makeProduct({ stock: 5 });
  const u = await makeUser();
  const res = await api.post('/api/orders', { items: [{ sku: p.variants[0].sku, qty: 1 }], addressId: u.addressId }, { auth: u.auth });
  return { ...u, order: res.body.order };
}

const post = (body, signature) => app.inject({ method: 'POST', url: '/api/webhooks/gateway', payload: body, headers: { 'content-type': 'application/json', ...(signature ? { 'gateway-signature': signature } : {}) } });

test('webhooks without a valid, fresh signature are rejected', async () => {
  const body = JSON.stringify({ id: 'evt_x', type: 'payment.captured', data: { providerPaymentId: 'pay_x' } });
  assert.equal((await post(body)).statusCode, 401, 'missing signature');
  assert.equal((await post(body, 't=1,v1=deadbeef')).statusCode, 401, 'garbage signature');
  const tampered = body.replace('pay_x', 'pay_y');
  assert.equal((await post(tampered, signWebhook(body))).statusCode, 401, 'body changed after signing');
  const old = signWebhook(body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await post(body, old)).statusCode, 401, 'replayed old request');
  assert.equal((await post(body, signWebhook(body))).statusCode, 200, 'correct signature accepted');
  assert.equal(verifySignature(body, signWebhook(body, undefined, 'other-secret')), false, 'other secret');
});

test('a redelivered webhook is acknowledged once and applied once', async () => {
  const captured = [];
  setWebhookDeliverer(async (body, headers) => {
    captured.push({ body, headers });
    return injectDeliverer(body, headers);
  });
  const { order, auth } = await pendingOrder();
  await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  await waitFor(async () => (await Order.findById(order.id)).status === 'CONFIRMED');
  const { body, headers } = captured[0];
  await waitFor(() => WebhookEvent.exists({ eventId: JSON.parse(body).id })); // recorded after being applied
  const again = await app.inject({ method: 'POST', url: '/api/webhooks/gateway', payload: body, headers });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().duplicate, true);
  assert.equal((await Order.findById(order.id)).history.filter((h) => h.status === 'CONFIRMED').length, 1);
  setWebhookDeliverer(injectDeliverer);
});

test('money that arrives after the order closed is refunded automatically', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  setWebhookDeliverer(async (body, headers) => {
    await held; // hold the capture webhook back
    return injectDeliverer(body, headers);
  });
  const { order, auth } = await pendingOrder();
  await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  // Meanwhile the order closes (e.g. an admin/system cancels it) before the bank answers.
  await Order.updateOne({ _id: order.id }, { $set: { status: 'CANCELLED' } });
  setWebhookDeliverer(injectDeliverer); // the refund webhook goes straight through
  release();
  await waitFor(async () => (await Payment.findOne({ order: order.id }))?.status === 'REFUNDED');
  const h = (await Order.findById(order.id)).history.map((x) => x.note).join(' | ');
  assert.match(h, /refund started automatically/);
});

test('reconciliation recovers a payment whose webhook never arrived', async () => {
  setWebhookDeliverer(async () => 500); // gateway can't reach us at all
  const { order, auth } = await pendingOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  assert.equal(res.status, 202);
  await sleep(50); // the gateway has decided by now, but nobody told us
  assert.equal((await Order.findById(order.id)).status, 'PENDING_PAYMENT');
  assert.equal((await Order.findById(order.id)).payment.status, 'PROCESSING');
  const fixed = await reconcilePayments(0);
  assert.equal(fixed, 1);
  assert.equal((await Order.findById(order.id)).status, 'CONFIRMED');
  assert.equal((await Payment.findOne({ order: order.id })).status, 'CAPTURED');
  setWebhookDeliverer(injectDeliverer);
});

test('payment status endpoint is owner-only', async () => {
  const { order, auth } = await pendingOrder();
  const res = await api.post(`/api/orders/${order.id}/pay`, card(), { auth, headers: idem() });
  const other = await makeUser();
  assert.equal((await api.get(`/api/payments/${res.body.payment.id}`, { auth: other.auth })).status, 404);
  assert.equal((await api.get(`/api/payments/${res.body.payment.id}`, { auth })).status, 200);
  await waitFor(async () => (await Order.findById(order.id)).status === 'CONFIRMED');
});
