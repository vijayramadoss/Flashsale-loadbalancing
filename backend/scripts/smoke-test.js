// End-to-end feature check over real HTTP — through the load balancer by default.
// Acts as a shopper and as the admin and exercises every feature once, printing
// ✔ / ✖ per check. Exit code 1 if anything failed.
//
//   node --env-file=.env --env-file=.env.sim scripts/smoke-test.js [--base=http://127.0.0.1:8088]
//
// Needs: the stack running (infra/start-lb-demo.ps1 or docker compose) and the
// admin account from ADMIN_EMAIL / ADMIN_PASSWORD present (seed or simulator).
import { createHash } from 'node:crypto';
import { config } from '../src/config/env.js';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8088').slice(7);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 SmokeTest';
const ip = `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const replicas = new Set();

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'User-Agent': UA, 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.headers.get('x-served-by')) replicas.add(res.headers.get('x-served-by'));
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

async function until(fn, timeout = 20000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > timeout) return null;
    await sleep(300);
  }
}

const pay = async (token, orderId, body, key) => {
  const r = await call('POST', `/api/orders/${orderId}/pay`, { token, body, headers: { 'Idempotency-Key': key } });
  if (r.status !== 202) return { first: r, final: r.body?.payment };
  const final = await until(async () => {
    const p = (await call('GET', `/api/payments/${r.body.payment.id}`, { token })).body?.payment;
    return p && p.status !== 'PROCESSING' ? p : null;
  });
  return { first: r, final };
};
const orderOf = async (token, id) => (await call('GET', `/api/orders/${id}`, { token })).body?.order;

console.log(`Smoke test against ${BASE}\n`);

// ---------- infrastructure ----------
const ready = await call('GET', '/api/health/ready');
check('health: MongoDB + Redis reachable through the load balancer', ready.status === 200 && ready.body.mongo && ready.body.redis);
const spa = await fetch(`${BASE}/phones`, { headers: { 'User-Agent': UA } });
check('storefront served (SPA fallback)', spa.status === 200 && (spa.headers.get('content-type') || '').includes('text/html'));

// ---------- accounts ----------
const email = `smoke-${Date.now()}@example.test`;
const reg = await call('POST', '/api/auth/register', { body: { name: 'Smoke Tester', email, password: 'smoke-password-123' } });
check('register', reg.status === 201 && reg.body.user.role === 'customer');
const login = await call('POST', '/api/auth/login', { body: { email, password: 'smoke-password-123' } });
const token = login.body?.token;
check('login + /me', login.status === 200 && (await call('GET', '/api/auth/me', { token })).body?.user?.email === email);
const addr = await call('POST', '/api/account/addresses', { token, body: { fullName: 'Smoke Tester', phone: '9876501234', line1: '7 Test Lane', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' } });
check('address book: add (becomes default)', addr.status === 201 && addr.body.address.isDefault);
const addressId = addr.body.address.id;

const adminLogin = await call('POST', '/api/auth/login', { body: { email: config.adminEmail, password: config.adminPassword } });
const admin = adminLogin.body?.token;
check('admin login', adminLogin.status === 200 && adminLogin.body.user.role === 'admin');

// ---------- catalog ----------
const list = await call('GET', '/api/products?brand=Samsung&sort=price_asc');
check('catalog: filter + sort', list.status === 200 && list.body.items.length > 0 && list.body.items.every((p) => p.brand === 'Samsung'));
const search = await call('GET', '/api/products?q=pixel');
check('catalog: search', search.body.items.some((p) => /pixel/i.test(p.name)));
const product = (await call('GET', `/api/products/${search.body.items[0].slug}`)).body.product;
const variant = product.variants.find((v) => v.stockLevel !== 'OUT');
check('product detail with variants and stock hints', product.variants.length > 0 && Boolean(variant));

// ---------- wishlist ----------
await call('PUT', `/api/account/wishlist/${product.slug}`, { token });
const wl = await call('GET', '/api/account/wishlist', { token });
await call('DELETE', `/api/account/wishlist/${product.slug}`, { token });
check('wishlist: add, list, remove', wl.body.items.some((i) => i.slug === product.slug) && (await call('GET', '/api/account/wishlist', { token })).body.items.length === 0);

// ---------- coupons ----------
const code = `SMOKE${Date.now().toString(36).toUpperCase().slice(-5)}`;
const coupon = await call('POST', '/api/admin/coupons', {
  token: admin,
  body: { code, type: 'PERCENT', value: 10, maxDiscountCents: 300000, validFrom: new Date(Date.now() - 60000).toISOString(), validTo: new Date(Date.now() + 86400000).toISOString(), usageLimit: 5 },
});
check('admin: create coupon', coupon.status === 201);
const quote = await call('POST', '/api/cart/quote', { token, body: { items: [{ sku: variant.sku, qty: 1 }], couponCode: code } });
check('cart quote applies the coupon', quote.body.coupon?.discountCents > 0 && quote.body.pricing.couponDiscountCents === quote.body.coupon.discountCents);

// ---------- cart order + async payment ----------
const placed = await call('POST', '/api/orders', { token, body: { items: [{ sku: variant.sku, qty: 1 }], addressId, couponCode: code, deliveryMethod: 'EXPRESS' } });
check('place cart order (stock held, coupon redeemed)', placed.status === 201 && placed.body.order.coupon?.code === code);
const orderId = placed.body.order.id;
const decline = await pay(token, orderId, { method: 'CARD', card: { number: '4000000000000002', expiry: '12/30', cvc: '123', name: 'Smoke' } }, `smk-${Date.now()}-a`);
check('card decline: 202 → webhook → FAILED, order still payable', decline.first.status === 202 && decline.final?.status === 'FAILED' && (await orderOf(token, orderId)).canPay);
const upi = await pay(token, orderId, { method: 'UPI', upi: { vpa: 'smoke@okbank' } }, `smk-${Date.now()}-b`);
const confirmed = await until(async () => {
  const o = await orderOf(token, orderId);
  return o?.status === 'CONFIRMED' && o.invoice ? o : null;
});
check('UPI retry: CAPTURED via signed webhook through NGINX → CONFIRMED', upi.final?.status === 'CAPTURED' && Boolean(confirmed));
const invoice = (await call('GET', `/api/orders/${orderId}/invoice`, { token })).body?.invoice;
check('invoice: number + GST split adds up', Boolean(invoice?.invoiceNumber) && invoice.tax.taxableCents + invoice.tax.cgstCents + invoice.tax.sgstCents === invoice.pricing.totalCents);

// ---------- fulfilment, review, return ----------
await call('POST', `/api/admin/orders/${orderId}/status`, { token: admin, body: { status: 'SHIPPED' } });
const delivered = await call('POST', `/api/admin/orders/${orderId}/status`, { token: admin, body: { status: 'DELIVERED' } });
check('admin: ship → deliver', delivered.body?.order?.status === 'DELIVERED');
const before = (await call('GET', `/api/products/${product.slug}`)).body.product.ratingCount;
const review = await call('POST', `/api/products/${product.slug}/reviews`, { token, body: { rating: 4, title: 'Solid phone', body: 'Smoke-test review.' } });
const after = (await call('GET', `/api/products/${product.slug}`)).body.product.ratingCount;
check('verified-purchase review updates the rating', review.status === 201 && after === before + 1);
const ret = await call('POST', `/api/orders/${orderId}/return`, { token, body: { reason: 'Smoke test return request' } });
const decided = await call('POST', `/api/admin/orders/${orderId}/return-decision`, { token: admin, body: { approve: true } });
const refunded = await until(async () => (await orderOf(token, orderId))?.payment.status === 'REFUNDED');
check('return: request → approve → refund webhook', ret.body?.order?.returnRequest?.status === 'REQUESTED' && decided.body?.order?.status === 'RETURNED' && Boolean(refunded));

// ---------- cancel with COD ----------
const o2 = (await call('POST', '/api/orders', { token, body: { items: [{ sku: variant.sku, qty: 1 }], addressId } })).body.order;
const cod = await call('POST', `/api/orders/${o2.id}/pay`, { token, body: { method: 'COD' }, headers: { 'Idempotency-Key': `smk-${Date.now()}-c` } });
const cancelled = await call('POST', `/api/orders/${o2.id}/cancel`, { token });
check('cash on delivery → cancel', cod.body?.order?.status === 'CONFIRMED' && cancelled.body?.order?.status === 'CANCELLED');

// ---------- admin catalog ----------
const adminProducts = (await call('GET', '/api/admin/products', { token: admin })).body.products;
const ap = adminProducts.find((p) => p.slug === product.slug);
const stockBefore = ap.variants.find((v) => v.sku === variant.sku).stock;
const plus = await call('POST', `/api/admin/products/${ap.id}/variants/${variant.sku}/stock`, { token: admin, body: { delta: 3 } });
const minus = await call('POST', `/api/admin/products/${ap.id}/variants/${variant.sku}/stock`, { token: admin, body: { delta: -3 } });
check('admin: atomic stock +3 / -3', plus.body?.product.variants.find((v) => v.sku === variant.sku).stock === stockBefore + 3 && minus.body?.product.variants.find((v) => v.sku === variant.sku).stock === stockBefore);

// ---------- flash deal behind a waiting room ----------
const dealSku = adminProducts.find((p) => p.slug !== product.slug && p.variants.some((v) => v.stock >= 0));
const dv = dealSku.variants[0];
const deal = await call('POST', '/api/admin/deals', {
  token: admin,
  body: { sku: dv.sku, title: 'Smoke waiting-room deal', dealPriceCents: dv.priceCents - 100000, totalStock: 5, startsAt: new Date(Date.now() + 4000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), waitingRoom: { enabled: true, releasePerSec: 2 } },
});
check('admin: create deal with waiting room', deal.status === 201 && deal.body.deal.waitingRoom.enabled);
const dealId = deal.body.deal.id;
const noToken = await call('POST', `/api/deals/${dealId}/reserve`, { token });
check('reserve without admission is refused', noToken.status === 403 && noToken.body.error.code === 'ADMISSION_REQUIRED');
const ch = (await call('GET', '/api/pow/challenge', { token })).body;
let nonce = 0;
const t0 = Date.now();
while (!createHash('sha256').update(`${ch.challenge}:${nonce}`).digest('hex').startsWith('0'.repeat(Math.ceil(ch.difficulty / 4)))) nonce++;
const joined = await call('POST', `/api/deals/${dealId}/queue`, { token, body: { challenge: ch.challenge, nonce: String(nonce) } });
check(`proof-of-work solved (${ch.difficulty} bits, ${Date.now() - t0} ms) and joined the room`, joined.status === 200 && joined.body.queue.phase === 'WAITING_FOR_START');
const admitted = await until(async () => {
  const q = (await call('GET', `/api/deals/${dealId}/queue`, { token })).body?.queue;
  return q?.phase === 'ADMITTED' ? q : null;
});
check('admitted after launch with a signed token', Boolean(admitted?.admissionToken));
const reserved = await call('POST', `/api/deals/${dealId}/reserve`, { token, headers: { 'X-Admission-Token': admitted?.admissionToken || '' } });
check('reserve with the admission token → 202', reserved.status === 202);
const resv = await until(async () => {
  const r = (await call('GET', reserved.body.trackingUrl, { token })).body?.reservation;
  return r?.status === 'RESERVED' ? r : null;
});
check('queue worker created the pending order', Boolean(resv?.orderId));
await call('PUT', `/api/orders/${resv.orderId}/shipping`, { token, body: { addressId } });
const dealPay = await pay(token, resv.orderId, { method: 'CARD', card: { number: '4242424242424242', expiry: '12/30', cvc: '123', name: 'Smoke' } }, `smk-${Date.now()}-d`);
const dealOrder = await until(async () => ((await orderOf(token, resv.orderId))?.status === 'CONFIRMED' ? true : null));
check('flash-deal order paid and confirmed', dealPay.final?.status === 'CAPTURED' && Boolean(dealOrder));
const stats = (await call('GET', `/api/admin/deals/${dealId}/stats`, { token: admin })).body.stats;
check('deal consistency: Mongo and Redis agree, not oversold', stats.mongo.remainingStock === 4 && stats.redis.remainingTokens === 4 && !stats.consistency.oversold);

// ---------- security + observability ----------
const forged = await call('POST', '/api/webhooks/gateway', { body: { id: 'evt_forged', type: 'payment.captured', data: { providerPaymentId: 'x' } }, headers: { 'Gateway-Signature': 't=1,v1=00' } });
check('forged webhook rejected (401)', forged.status === 401);
const botBlocked = await fetch(`${BASE}/api/deals/${dealId}/reserve`, { method: 'POST', headers: { 'User-Agent': 'curl/8.0' } });
check('bot user-agent blocked', botBlocked.status === 403);
const metrics = await fetch('http://127.0.0.1:4001/metrics').then((r) => r.text()).catch(() => '');
check('replica /metrics in Prometheus format', /flashsale_http_requests_total\{/.test(metrics) && /flashsale_queue_backlog/.test(metrics));
check(`requests were served by several replicas (${[...replicas].sort().join(', ')})`, replicas.size >= 2);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
