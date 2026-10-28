// Coupons, reviews, wishlist, returns, invoices, admin catalog editing, /metrics.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Product } from '../src/models/Product.js';
import { Order } from '../src/models/Order.js';
import { Coupon, CouponRedemption } from '../src/models/Coupon.js';
import { expireDueOrders } from '../src/services/orderService.js';
import { setup, teardown, resetData, client, makeUser, makeProduct, card, payAndSettle, waitFor } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

const day = 86_400_000;
const makeCoupon = (o = {}) =>
  Coupon.create({ code: 'SAVE10', type: 'PERCENT', value: 10, maxDiscountCents: 150_000, minOrderCents: 500_000, validFrom: new Date(Date.now() - day), validTo: new Date(Date.now() + day), usageLimit: 100, ...o });

async function deliveredOrder() {
  const p = await makeProduct({ stock: 5, priceCents: 1_000_000, mrpCents: 1_100_000 });
  const u = await makeUser();
  const admin = await makeUser({ role: 'admin' });
  const { body } = await api.post('/api/orders', { items: [{ sku: p.variants[0].sku, qty: 1 }], addressId: u.addressId }, { auth: u.auth });
  await payAndSettle(api, body.order.id, card(), u.auth);
  await api.post(`/api/admin/orders/${body.order.id}/status`, { status: 'SHIPPED' }, { auth: admin.auth });
  await api.post(`/api/admin/orders/${body.order.id}/status`, { status: 'DELIVERED' }, { auth: admin.auth });
  return { p, u, admin, orderId: body.order.id };
}

// ---------------- coupons ----------------

test('coupon preview in the cart quote: discount, cap, minimum order and errors', async () => {
  await makeCoupon();
  await makeCoupon({ code: 'FLAT500', type: 'FLAT', value: 50_000, maxDiscountCents: undefined, minOrderCents: 0 });
  await makeCoupon({ code: 'OLD', validTo: new Date(Date.now() - 1000), validFrom: new Date(Date.now() - day) });
  const p = await makeProduct({ priceCents: 2_000_000, mrpCents: 2_000_000 });
  const items = [{ sku: p.variants[0].sku, qty: 1 }];
  const pct = await api.post('/api/cart/quote', { items, couponCode: 'save10' });
  assert.equal(pct.body.coupon.discountCents, 150_000, '10 % of ₹20,000 = ₹2,000, capped at ₹1,500');
  assert.equal(pct.body.pricing.totalCents, 2_000_000 - 150_000);
  assert.equal((await api.post('/api/cart/quote', { items, couponCode: 'FLAT500' })).body.coupon.discountCents, 50_000);
  assert.equal((await api.post('/api/cart/quote', { items, couponCode: 'OLD' })).body.coupon.error.code, 'COUPON_EXPIRED');
  assert.equal((await api.post('/api/cart/quote', { items, couponCode: 'NOPE' })).body.coupon.error.code, 'COUPON_NOT_FOUND');
  const small = await makeProduct({ priceCents: 100_000, mrpCents: 100_000 });
  const min = await api.post('/api/cart/quote', { items: [{ sku: small.variants[0].sku, qty: 1 }], couponCode: 'SAVE10' });
  assert.equal(min.body.coupon.error.code, 'COUPON_MIN_ORDER');
});

test('a coupon is redeemed inside the order transaction, once per customer, and given back on expiry', async () => {
  await makeCoupon();
  const p = await makeProduct({ stock: 5, priceCents: 1_000_000, mrpCents: 1_000_000 });
  const u = await makeUser();
  const items = [{ sku: p.variants[0].sku, qty: 1 }];
  const first = await api.post('/api/orders', { items, addressId: u.addressId, couponCode: 'SAVE10' }, { auth: u.auth });
  assert.equal(first.status, 201);
  assert.equal(first.body.order.pricing.couponDiscountCents, 100_000);
  assert.equal(first.body.order.coupon.code, 'SAVE10');
  assert.equal((await Coupon.findOne({ code: 'SAVE10' })).usedCount, 1);
  const second = await api.post('/api/orders', { items, addressId: u.addressId, couponCode: 'SAVE10' }, { auth: u.auth });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'COUPON_ALREADY_USED');
  assert.equal((await Product.findById(p._id)).variants[0].stock, 4, 'the refused order did not take stock');
  await Order.updateOne({ _id: first.body.order.id }, { expiresAt: new Date(Date.now() - 1000) });
  await expireDueOrders();
  assert.equal((await Coupon.findOne({ code: 'SAVE10' })).usedCount, 0, 'use given back');
  assert.equal(await CouponRedemption.countDocuments(), 0);
});

test('a limited coupon cannot be over-redeemed by concurrent checkouts', async () => {
  await makeCoupon({ code: 'ONLY3', usageLimit: 3, minOrderCents: 0 });
  const p = await makeProduct({ stock: 50 });
  const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
  const results = await Promise.all(users.map((u) => api.post('/api/orders', { items: [{ sku: p.variants[0].sku, qty: 1 }], addressId: u.addressId, couponCode: 'ONLY3' }, { auth: u.auth })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'COUPON_USED_UP' || r.body.error.code === 'COUPON_UNAVAILABLE'));
  assert.equal((await Coupon.findOne({ code: 'ONLY3' })).usedCount, 3);
});

test('admin coupon management is admin-only and validated', async () => {
  const admin = await makeUser({ role: 'admin' });
  const customer = await makeUser();
  const body = { code: 'diwali25', type: 'PERCENT', value: 25, maxDiscountCents: 500_000, validFrom: new Date().toISOString(), validTo: new Date(Date.now() + day).toISOString(), usageLimit: 1000 };
  assert.equal((await api.post('/api/admin/coupons', body, { auth: customer.auth })).status, 403);
  const created = await api.post('/api/admin/coupons', body, { auth: admin.auth });
  assert.equal(created.status, 201);
  assert.equal(created.body.coupon.code, 'DIWALI25');
  assert.equal((await api.post('/api/admin/coupons', body, { auth: admin.auth })).status, 409, 'duplicate code');
  assert.equal((await api.post('/api/admin/coupons', { ...body, code: 'TOOBIG', value: 95 }, { auth: admin.auth })).status, 400);
  const off = await api.post(`/api/admin/coupons/${created.body.coupon._id}/active`, { active: false }, { auth: admin.auth });
  assert.equal(off.body.coupon.active, false);
});

// ---------------- reviews ----------------

test('only verified buyers can review, once; the product average updates atomically', async () => {
  const { p, u } = await deliveredOrder();
  const stranger = await makeUser();
  const before = await api.get(`/api/products/${p.slug}/reviews`, { auth: stranger.auth });
  assert.equal(before.body.canReview, false);
  assert.equal(before.body.cannotReviewReason, 'NOT_PURCHASED');
  assert.equal((await api.post(`/api/products/${p.slug}/reviews`, { rating: 5, title: 'Great' }, { auth: stranger.auth })).status, 403);

  const mine = await api.get(`/api/products/${p.slug}/reviews`, { auth: u.auth });
  assert.equal(mine.body.canReview, true);
  const r = await api.post(`/api/products/${p.slug}/reviews`, { rating: 2, title: 'Battery could be better', body: 'Lasts a day.' }, { auth: u.auth });
  assert.equal(r.status, 201);
  assert.equal(r.body.review.authorName, 'Test U.');
  assert.equal((await api.post(`/api/products/${p.slug}/reviews`, { rating: 5, title: 'Again' }, { auth: u.auth })).status, 409);

  const after = await Product.findById(p._id);
  // makeProduct seeds rating 4 × N existing ratings; the new 2-star review is added to sum and count.
  assert.equal(after.ratingCount, p.ratingCount + 1);
  assert.equal(after.rating, Math.round(((4 * p.ratingCount + 2) / (p.ratingCount + 1)) * 10) / 10);
  const list = await api.get(`/api/products/${p.slug}/reviews`);
  assert.equal(list.body.reviews.length, 1);
  assert.equal(list.body.histogram['2'], 1);
});

// ---------------- wishlist ----------------

test('wishlist: add (idempotent), list with prices, remove', async () => {
  const p = await makeProduct();
  const u = await makeUser();
  assert.equal((await api.put(`/api/account/wishlist/${p.slug}`, undefined, { auth: u.auth })).status, 204);
  assert.equal((await api.put(`/api/account/wishlist/${p.slug}`, undefined, { auth: u.auth })).status, 204);
  const list = await api.get('/api/account/wishlist', { auth: u.auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].slug, p.slug);
  assert.ok(list.body.items[0].priceCents > 0);
  assert.equal((await api.put('/api/account/wishlist/no-such-phone', undefined, { auth: u.auth })).status, 404);
  await api.del(`/api/account/wishlist/${p.slug}`, { auth: u.auth });
  assert.equal((await api.get('/api/account/wishlist', { auth: u.auth })).body.items.length, 0);
  assert.equal((await api.get('/api/account/wishlist')).status, 401);
});

// ---------------- returns + invoices ----------------

test('return flow: request within the window → admin approves → item restocked and refunded', async () => {
  const { p, u, admin, orderId } = await deliveredOrder();
  const stockBefore = (await Product.findById(p._id)).variants[0].stock;
  assert.equal((await api.post(`/api/orders/${orderId}/return`, { reason: 'no' }, { auth: u.auth })).status, 400, 'reason too short');
  const req = await api.post(`/api/orders/${orderId}/return`, { reason: 'Screen has a dead pixel' }, { auth: u.auth });
  assert.equal(req.body.order.returnRequest.status, 'REQUESTED');
  assert.equal(req.body.order.canReturn, false);
  assert.equal((await api.post(`/api/orders/${orderId}/return`, { reason: 'Screen has a dead pixel' }, { auth: u.auth })).status, 409);
  const pendingList = await api.get('/api/admin/orders?returns=true', { auth: admin.auth });
  assert.equal(pendingList.body.orders.length, 1);
  const ok = await api.post(`/api/admin/orders/${orderId}/return-decision`, { approve: true }, { auth: admin.auth });
  assert.equal(ok.body.order.status, 'RETURNED');
  assert.equal((await Product.findById(p._id)).variants[0].stock, stockBefore + 1, 'restocked');
  await waitFor(async () => (await Order.findById(orderId)).payment.status === 'REFUNDED');
});

test('returns are refused outside the window', async () => {
  const { u, orderId } = await deliveredOrder();
  await Order.updateOne({ _id: orderId }, { deliveredAt: new Date(Date.now() - 30 * day) });
  const res = await api.post(`/api/orders/${orderId}/return`, { reason: 'Changed my mind' }, { auth: u.auth });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'RETURN_NOT_ALLOWED');
});

test('invoices: sequential numbers, GST split adds up, only after confirmation', async () => {
  const p = await makeProduct({ stock: 9, priceCents: 1_180_000, mrpCents: 1_180_000 });
  const u = await makeUser();
  const a = (await api.post('/api/orders', { items: [{ sku: p.variants[0].sku, qty: 1 }], addressId: u.addressId }, { auth: u.auth })).body.order;
  assert.equal((await api.get(`/api/orders/${a.id}/invoice`, { auth: u.auth })).status, 409, 'no invoice before payment');
  await payAndSettle(api, a.id, card(), u.auth);
  const b = (await api.post('/api/orders', { items: [{ sku: p.variants[1].sku, qty: 1 }], addressId: u.addressId }, { auth: u.auth })).body.order;
  await api.post(`/api/orders/${b.id}/pay`, { method: 'COD' }, { auth: u.auth, headers: { 'idempotency-key': 'cod-key-123' } });
  const ia = (await api.get(`/api/orders/${a.id}/invoice`, { auth: u.auth })).body.invoice;
  const ib = (await api.get(`/api/orders/${b.id}/invoice`, { auth: u.auth })).body.invoice;
  assert.equal(Number(ib.invoiceNumber.slice(-6)), Number(ia.invoiceNumber.slice(-6)) + 1);
  assert.equal(ia.tax.taxableCents + ia.tax.cgstCents + ia.tax.sgstCents, ia.pricing.totalCents);
  assert.equal(ia.tax.taxableCents, 1_000_000, '₹11,800 incl. 18 % GST = ₹10,000 taxable');
  assert.equal((await api.get(`/api/orders/${a.id}/invoice`, { auth: (await makeUser()).auth })).status, 404);
});

// ---------------- admin catalog + metrics ----------------

test('admin catalog: edit details, price (≤ MRP), atomic stock deltas, add a variant', async () => {
  const admin = await makeUser({ role: 'admin' });
  const p = await makeProduct({ stock: 3, priceCents: 1_000_000, mrpCents: 1_200_000 });
  const sku = p.variants[0].sku;
  assert.equal((await api.get('/api/admin/products', { auth: (await makeUser()).auth })).status, 403);
  const patch = (url, body) => app.inject({ method: 'PATCH', url, payload: body, headers: { ...admin.auth, 'content-type': 'application/json' } });
  assert.equal((await patch(`/api/admin/products/${p._id}`, { tagline: 'Updated tagline' })).json().product.tagline, 'Updated tagline');
  assert.equal((await patch(`/api/admin/products/${p._id}/variants/${sku}`, { priceCents: 1_300_000 })).statusCode, 400, 'price above MRP');
  const cheaper = (await patch(`/api/admin/products/${p._id}/variants/${sku}`, { priceCents: 900_000 })).json().product;
  assert.equal(cheaper.variants[0].priceCents, 900_000);
  assert.equal((await Product.findById(p._id)).minPriceCents, 900_000, 'denormalised min price recomputed');
  const plus = await api.post(`/api/admin/products/${p._id}/variants/${sku}/stock`, { delta: 10 }, { auth: admin.auth });
  assert.equal(plus.body.product.variants[0].stock, 13);
  const tooMany = await api.post(`/api/admin/products/${p._id}/variants/${sku}/stock`, { delta: -50 }, { auth: admin.auth });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, 'INSUFFICIENT_STOCK');
  const added = await api.post(`/api/admin/products/${p._id}/variants`, { color: 'Ocean Blue', colorHex: '#1b4d89', storage: '512 GB', ram: '12 GB', priceCents: 1_500_000, mrpCents: 1_600_000, stock: 7 }, { auth: admin.auth });
  assert.equal(added.status, 201);
  assert.ok(added.body.product.variants.some((v) => v.sku.endsWith('-12-512-OCEBLU')));
});

test('/metrics exposes Prometheus counters and histograms (internal only)', async () => {
  await api.get('/api/products');
  const res = await app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /flashsale_http_requests_total\{replica="[^"]+",method="GET",route="\/api\/products",status="200"\} \d+/);
  assert.match(res.body, /flashsale_http_request_duration_seconds_bucket\{.*le="\+Inf"\}/);
  assert.match(res.body, /flashsale_queue_backlog \d+/);
  const outside = await app.inject({ method: 'GET', url: '/metrics', remoteAddress: '203.0.113.9' });
  assert.equal(outside.statusCode, 403);
});
