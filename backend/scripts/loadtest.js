// Flash-sale load test + integrity check.
//
// 1. Creates a fresh sale (default 500 units) that starts a few seconds from now.
// 2. Mints JWTs for many synthetic buyers (no DB round-trip; same secret as the API).
// 3. Waits for the start, then fires a burst of checkout requests at the RUNNING
//    API (ideally the cluster: `npm run start:loadtest`), each buyer clicking
//    several times, from many simulated client IPs (X-Forwarded-For, as NGINX would send).
// 4. Waits for the order worker to drain the queue and verifies:
//      orders == stock, Mongo remaining == 0, no 5xx, no network errors/timeouts.
//
// Uses the isolated database / Redis prefix from .env.loadtest so dev data is untouched.
// Usage: npm run loadtest -- [--requests=20000] [--buyers=5000] [--connections=200] [--stock=500]
import autocannon from 'autocannon';
import mongoose from 'mongoose';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, getRedis, waitForRedis } from '../src/lib/redis.js';
import { createSale, getSaleStats } from '../src/services/saleService.js';
import { signToken } from '../src/services/authService.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const REQUESTS = arg('requests', 20000);
const BUYERS = arg('buyers', 5000);
const CONNECTIONS = arg('connections', 200);
const STOCK = arg('stock', 500);
const TARGET = process.env.LOADTEST_URL || `http://127.0.0.1:${config.port}`;

if (!/_load/.test(config.mongoUri)) {
  console.error('Refusing to run: use the isolated load-test database (npm run loadtest loads .env.loadtest).');
  process.exit(1);
}

await connectMongo();
await waitForRedis(getRedis());

const startsAt = new Date(Date.now() + 4000);
const sale = await createSale({
  title: `Load test ${new Date().toISOString()}`,
  startsAt,
  endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  totalStock: STOCK,
  product: { name: 'Load Test Phone', priceCents: 100, currency: 'INR' },
});
const saleId = sale._id.toString();

const buyers = Array.from({ length: BUYERS }, (_, i) => ({
  auth: `Bearer ${signToken({ _id: new mongoose.Types.ObjectId(), role: 'customer', name: `buyer${i}` })}`,
  ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
}));
const body = JSON.stringify({ saleId });
const statusCounts = {};
let n = 0;

console.log(`Sale ${saleId}: ${STOCK} units. ${REQUESTS} requests from ${BUYERS} buyers over ${CONNECTIONS} connections → ${TARGET}`);
await new Promise((r) => setTimeout(r, Math.max(0, startsAt - Date.now()) + 50));

const t0 = Date.now();
const result = await autocannon({
  url: TARGET,
  connections: CONNECTIONS,
  amount: REQUESTS,
  timeout: 10,
  requests: [
    {
      method: 'POST',
      path: '/api/checkout',
      setupRequest: (req) => {
        const b = buyers[n++ % BUYERS];
        return {
          ...req,
          body,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (LoadTest) AppleWebKit/537.36 Chrome/130 Safari/537.36',
            authorization: b.auth,
            'x-forwarded-for': b.ip,
          },
        };
      },
      onResponse: (status) => {
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      },
    },
  ],
});
const burstMs = Date.now() - t0;

// Wait for the worker to drain the queue.
let stats;
const drainStart = Date.now();
for (;;) {
  stats = await getSaleStats(saleId);
  if (stats.queue.pendingUnacked === 0 && stats.mongo.confirmedOrders === STOCK - (stats.redis.remainingTokens ?? 0)) break;
  if (Date.now() - drainStart > 60_000) break;
  await new Promise((r) => setTimeout(r, 250));
}
const drainMs = Date.now() - drainStart;

const answered = Object.values(statusCounts).reduce((a, b) => a + b, 0);
const fiveXX = Object.entries(statusCounts).filter(([s]) => s >= 500).reduce((a, [, c]) => a + c, 0);
const report = {
  requests: REQUESTS,
  answered,
  statusCounts,
  networkErrors: result.errors,
  timeouts: result.timeouts,
  burstSeconds: +(burstMs / 1000).toFixed(2),
  throughputReqPerSec: Math.round(answered / (burstMs / 1000)),
  latencyMs: { p50: result.latency.p50, p90: result.latency.p90, p99: result.latency.p99, max: result.latency.max },
  queueDrainSeconds: +(drainMs / 1000).toFixed(2),
  integrity: stats,
};
console.log(JSON.stringify(report, null, 2));

const checks = [
  ['every request got an HTTP answer', answered === REQUESTS && result.errors === 0 && result.timeouts === 0],
  ['no 5xx responses', fiveXX === 0],
  [`exactly ${STOCK} accepted (202)`, statusCounts[202] === STOCK],
  [`exactly ${STOCK} orders in MongoDB`, stats.mongo.confirmedOrders === STOCK],
  ['Mongo remaining stock is 0', stats.mongo.remainingStock === 0],
  ['not oversold', !stats.consistency.oversold && stats.consistency.countersMatchOrders],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`);
  failed ||= !ok;
}

await closeRedis();
await disconnectMongo();
process.exit(failed ? 1 : 0);
