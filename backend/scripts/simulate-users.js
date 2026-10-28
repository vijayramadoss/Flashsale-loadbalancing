// 10,000-user flash-sale simulation THROUGH THE LOAD BALANCER.
//
// Unlike scripts/loadtest.js (raw request blasting), every virtual user here is
// a real account with a saved address that walks the actual shopper journey
// against NGINX (http://127.0.0.1:8088 → api-1..3):
//
//   1. arrives during the countdown and polls the deal status (served mostly
//      from NGINX's 1-second micro-cache),
//   2. reacts to "LIVE" after a human-ish delay and presses Buy now — some
//      impatient users press it several times,
//   3. if admitted (202), polls the reservation until the worker has created
//      the pending order (RESERVED) — or gets SOLD_OUT,
//   4. winners fill in the checkout: choose delivery (PUT shipping), then pay:
//      most succeed, some get a card decline and retry by UPI, some abandon
//      (their hold expires later and the unit returns to sale).
//
// At the end it checks the invariants straight from MongoDB/Redis and prints a
// funnel, per-step latencies, status codes and the split of requests per replica
// (from the X-Served-By header every replica adds).
//
// Usage (in backend/, with infra/start-lb-demo.ps1 running):
//   node --env-file=.env --env-file=.env.sim scripts/simulate-users.js -- --users=10000 --stock=500
// Options: --users --stock --starts-in-sec=20 --base=http://127.0.0.1:8088 --sockets=400
//          --abandon-rate=0.12 --decline-rate=0.08 --spam-rate=0.25 --hold-min=10
import http from 'node:http';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, getRedis, waitForRedis } from '../src/lib/redis.js';
import { User } from '../src/models/User.js';
import { Product } from '../src/models/Product.js';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { signToken } from '../src/services/authService.js';
import { createDeal, getDealStats } from '../src/services/dealService.js';
import { catalog } from './catalog-data.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const v = hit.split('=').slice(1).join('=');
  return typeof fallback === 'number' ? Number(v) : v;
};
const USERS = arg('users', 10000);
const STOCK = arg('stock', 500);
const STARTS_IN_SEC = arg('starts-in-sec', 20);
const BASE = arg('base', 'http://127.0.0.1:8088');
const SOCKETS = arg('sockets', 400); // client + upstream connections must stay under Windows NGINX's 1,024
const ABANDON = arg('abandon-rate', 0.12);
const DECLINE = arg('decline-rate', 0.08);
const SPAM = arg('spam-rate', 0.25);
const HOLD_MIN = arg('hold-min', 10);

if (!/_sim\b|_sim\?/.test(config.mongoUri)) {
  console.error('Refusing to run: load backend/.env.sim (isolated flashsale_sim database).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pct = (arr, p) => (arr.length ? arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

// ---------------------------------------------------------------- HTTP client
const agent = new http.Agent({ keepAlive: true, maxSockets: SOCKETS });
const stats = { requests: 0, byStatus: {}, byReplica: {}, cacheHits: 0, netErrors: 0, steps: {} };

function call(method, path, { token, body, ip, headers = {}, step }) {
  const started = performance.now();
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      {
        method,
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 FlashSaleSim',
          'X-Forwarded-For': ip, // NGINX appends 127.0.0.1; the API trusts loopback, so this becomes the client IP
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const ms = performance.now() - started;
          stats.requests++;
          stats.byStatus[res.statusCode] = (stats.byStatus[res.statusCode] || 0) + 1;
          // A cached response still carries the original replica's header, so check the cache first.
          const served = res.headers['x-cache'] === 'HIT' ? 'nginx-cache' : res.headers['x-served-by'] || 'unknown';
          stats.byReplica[served] = (stats.byReplica[served] || 0) + 1;
          if (res.headers['x-cache'] === 'HIT') stats.cacheHits++;
          (stats.steps[step] ??= []).push(ms);
          let json = null;
          try { json = JSON.parse(data); } catch { /* empty */ }
          resolve({ status: res.statusCode, body: json, headers: res.headers, ms });
        });
      },
    );
    req.on('error', () => {
      stats.netErrors++;
      resolve({ status: 0, body: null, headers: {}, ms: performance.now() - started });
    });
    req.end(payload);
  });
}

// ---------------------------------------------------------------- setup
await connectMongo();
await waitForRedis(getRedis());
for (const m of [User, Product, Deal, Order]) await m.syncIndexes();

// Catalog + admin (for the dashboard) — only created if missing.
let product = await Product.findOne({ slug: 'oneplus-13' });
if (!product) {
  await Product.insertMany(catalog);
  product = await Product.findOne({ slug: 'oneplus-13' });
}
if (config.adminPassword && !(await User.exists({ email: config.adminEmail }))) {
  await User.create({ name: 'Store Admin', email: config.adminEmail, passwordHash: await bcrypt.hash(config.adminPassword, 10), role: 'admin' });
}

// Fresh simulated shoppers (previous simulation data is removed first).
const old = await User.find({ email: /@sim\.test$/ }, { _id: 1 }).lean();
await Order.deleteMany({ user: { $in: old.map((u) => u._id) } });
await User.deleteMany({ email: /@sim\.test$/ });
console.log(`Creating ${USERS.toLocaleString()} shopper accounts (with a saved address each)…`);
const hash = await bcrypt.hash('sim-password-not-used', 4);
const docs = Array.from({ length: USERS }, (_, i) => ({
  name: `Shopper ${i + 1}`,
  email: `shopper${i + 1}@sim.test`,
  passwordHash: hash,
  role: 'customer',
  addresses: [{ label: 'Home', fullName: `Shopper ${i + 1}`, phone: `9${String(100000000 + i).slice(-9)}`, line1: `${i + 1} Market Road`, city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true }],
}));
const users = [];
for (let i = 0; i < docs.length; i += 2000) users.push(...(await User.insertMany(docs.slice(i, i + 2000))));

const variant = product.variants.find((v) => v.color === 'Black Eclipse' && v.storage === '256 GB') || product.variants[0];
const startsAt = new Date(Date.now() + STARTS_IN_SEC * 1000);
const deal = await createDeal({
  sku: variant.sku,
  title: `Simulation deal ${new Date().toLocaleTimeString()}`,
  dealPriceCents: Math.min(variant.priceCents - 100, 4_999_900),
  totalStock: STOCK,
  startsAt,
  endsAt: new Date(startsAt.getTime() + 60 * 60_000),
  holdMinutes: HOLD_MIN,
});
const dealId = deal._id.toString();
console.log(`Deal ${dealId}: ${STOCK} units of ${product.name}, opens at ${startsAt.toLocaleTimeString()} (${STARTS_IN_SEC}s). Traffic goes to ${BASE}.`);

// ---------------------------------------------------------------- the shopper
const funnel = { arrived: 0, clicked: 0, extraClicks: 0, admitted: 0, reserved: 0, soldOut: 0, failed: 0, rateLimited: 0, paid: 0, declinedThenPaid: 0, abandoned: 0, errors: 0 };

async function shopper(u, i) {
  const token = signToken({ _id: u._id, role: 'customer', name: u.name });
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const addressId = u.addresses[0]._id.toString();
  const auth = { token, ip };

  // 1. Arrive some time during the countdown and watch the deal (polling every 1-3 s).
  //    Like the real UI, the button unlocks from the LOCAL countdown at T-0 — no poll needed.
  await sleep(rand(0, Math.max(0, startsAt - Date.now() - 1500)));
  funnel.arrived++;
  while (Date.now() < startsAt) {
    await call('GET', `/api/deals/${dealId}`, { ...auth, step: 'deal status' });
    await sleep(Math.min(rand(1000, 3000), Math.max(0, startsAt - Date.now())));
  }

  // 2. Human reaction time, then "Buy now" (impatient users click repeatedly).
  await sleep(rand(80, 1800));
  funnel.clicked++;
  const clicks = Math.random() < SPAM ? 1 + Math.floor(rand(1, 4)) : 1;
  funnel.extraClicks += clicks - 1;
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    const all = await Promise.all(Array.from({ length: clicks }, () => call('POST', `/api/deals/${dealId}/reserve`, { ...auth, step: 'reserve (buy now)' })));
    res = all.find((x) => x.status === 202 || x.status === 200) || all[0];
    const code = res.body?.error?.code;
    if (res.status === 429) funnel.rateLimited++;
    else if (code !== 'DEAL_NOT_STARTED') break; // clock skew of a few ms → just retry
    await sleep((Number(res.headers['retry-after']) || 1) * 1000 + rand(0, 400));
  }
  if (res.body?.error?.code === 'SOLD_OUT') return void funnel.soldOut++;
  if (res.status !== 202 && res.status !== 200) return void funnel.errors++;
  funnel.admitted++;

  // 3. Wait for the worker to turn the reservation into a pending order.
  let orderId = res.body.orderId;
  for (let n = 0; !orderId && n < 60; n++) {
    await sleep((Number(res.headers['retry-after']) || 1) * 1000 * 0.6);
    const r = await call('GET', res.body.trackingUrl, { ...auth, step: 'reservation poll' });
    if (r.body?.reservation?.status === 'RESERVED') orderId = r.body.reservation.orderId;
    else if (r.body?.reservation?.status === 'FAILED') return void funnel.failed++;
  }
  if (!orderId) return void funnel.errors++;
  funnel.reserved++;

  // 4. Checkout: delivery choice, then pay (or walk away).
  await sleep(rand(800, 3000));
  if (Math.random() < ABANDON) return void funnel.abandoned++;
  await call('PUT', `/api/orders/${orderId}/shipping`, { ...auth, body: { addressId, deliveryMethod: Math.random() < 0.3 ? 'EXPRESS' : 'STANDARD' }, step: 'checkout: shipping' });
  await sleep(rand(500, 2500));
  // Like the real checkout: POST /pay → 202 PROCESSING → poll the payment until the
  // gateway's webhook has decided (CAPTURED / FAILED).
  const pay = async (body, key) => {
    const r = await call('POST', `/api/orders/${orderId}/pay`, { ...auth, body, headers: { 'Idempotency-Key': key }, step: 'pay' });
    if (r.status !== 202) return r.status === 200 ? 'CAPTURED' : 'ERROR';
    for (let n = 0; n < 60; n++) {
      await sleep(500);
      const q = await call('GET', `/api/payments/${r.body.payment.id}`, { ...auth, step: 'payment poll' });
      if (q.body?.payment && q.body.payment.status !== 'PROCESSING') return q.body.payment.status;
    }
    return 'TIMEOUT';
  };
  let declined = false;
  if (Math.random() < DECLINE) {
    declined = (await pay({ method: 'CARD', card: { number: '4000000000000002', expiry: '12/30', cvc: '123', name: u.name } }, `sim-${i}-decline`)) === 'FAILED';
    await sleep(rand(500, 1500));
  }
  const result = await pay(
    declined ? { method: 'UPI', upi: { vpa: `shopper${i}@okbank` } } : { method: 'CARD', card: { number: '4242424242424242', expiry: '12/30', cvc: '123', name: u.name } },
    `sim-${i}-pay`,
  );
  if (result === 'CAPTURED') {
    funnel.paid++;
    if (declined) funnel.declinedThenPaid++;
  } else funnel.errors++;
}

// ---------------------------------------------------------------- run + live progress
const t0 = Date.now();
let lastReq = 0;
const ticker = setInterval(() => {
  const rps = stats.requests - lastReq;
  lastReq = stats.requests;
  const phase = Date.now() < startsAt ? `countdown ${Math.ceil((startsAt - Date.now()) / 1000)}s` : 'LIVE';
  const split = Object.entries(stats.byReplica).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`[${phase}] ${rps} req/s | arrived ${funnel.arrived} clicked ${funnel.clicked} admitted ${funnel.admitted} reserved ${funnel.reserved} paid ${funnel.paid} soldOut ${funnel.soldOut} | ${split}`);
}, 1000);

await Promise.all(users.map((u, i) => shopper(u, i).catch(() => funnel.errors++)));
clearInterval(ticker);
const seconds = (Date.now() - t0) / 1000;

// Let the worker finish anything in flight, then read the truth from the stores.
await sleep(1500);
const s = await getDealStats(dealId);
const pending = await Order.countDocuments({ deal: deal._id, status: 'PENDING_PAYMENT' });
const paidDb = await Order.countDocuments({ deal: deal._id, status: 'CONFIRMED' });

const latency = Object.fromEntries(
  Object.entries(stats.steps).map(([k, v]) => [k, { count: v.length, p50: Math.round(pct(v, 0.5)), p95: Math.round(pct(v, 0.95)), p99: Math.round(pct(v, 0.99)), max: Math.round(Math.max(...v)) }]),
);
const totalServed = Object.values(stats.byReplica).reduce((a, b) => a + b, 0);
console.log('\n================ SIMULATION REPORT ================');
console.log(`Users: ${USERS.toLocaleString()}   Units: ${STOCK}   Duration: ${seconds.toFixed(1)} s   Requests: ${stats.requests.toLocaleString()}   Network errors: ${stats.netErrors}`);
console.log('Funnel:', funnel);
console.log('HTTP status codes:', stats.byStatus);
console.log('Who served the requests (X-Served-By / NGINX cache):');
for (const [k, v] of Object.entries(stats.byReplica).sort()) console.log(`   ${k.padEnd(12)} ${String(v).padStart(7)}  ${((v / totalServed) * 100).toFixed(1)}%`);
console.log(`NGINX micro-cache hits on deal status: ${stats.cacheHits.toLocaleString()}`);
console.log('Latency per step (ms):');
console.table(latency);
console.log('Database truth:', { paidOrders: paidDb, pendingOrders: pending, mongoRemaining: s.mongo.remainingStock, redisTokens: s.redis.remainingTokens, consistency: s.consistency });

const checks = [
  ['no network errors / 5xx', stats.netErrors === 0 && !Object.keys(stats.byStatus).some((c) => Number(c) >= 500)],
  ['no shopper hit an unexpected error', funnel.errors === 0],
  [`exactly ${STOCK} units reserved`, funnel.reserved === STOCK && paidDb + pending === STOCK],
  ['paid + abandoned (still held) = reserved', paidDb === funnel.paid && pending === funnel.abandoned],
  ['MongoDB and Redis agree, nothing oversold', s.mongo.remainingStock === 0 && s.redis.remainingTokens === 0 && !s.consistency.oversold && s.consistency.countersMatchOrders],
  ['every API replica took part', ['api-1', 'api-2', 'api-3'].every((r) => (stats.byReplica[r] || 0) > 0)],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  failed ||= !ok;
}
console.log(`\nAbandoned holds expire at ~${new Date(startsAt.getTime() + HOLD_MIN * 60_000).toLocaleTimeString()}; the worker then returns those units to sale.`);

agent.destroy();
await closeRedis();
await disconnectMongo();
process.exit(failed ? 1 : 0);
