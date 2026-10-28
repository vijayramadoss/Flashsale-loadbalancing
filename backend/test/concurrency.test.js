// The core guarantee of the case study: under a burst of truly concurrent
// requests, exactly `stock` units are sold — never more.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { getRedis, keys } from '../src/lib/redis.js';
import { setup, teardown, resetData, makeDeal, syntheticBuyer, drainQueue } from './helpers.js';

let app;
let base;

before(async () => {
  app = await setup();
  await app.listen({ port: 0, host: '127.0.0.1', backlog: 4096 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  agent.destroy();
  app.server.closeAllConnections();
  await teardown(app);
});
beforeEach(resetData);

// Like NGINX's upstream keep-alive pool: up to 200 sockets to the API, all
// 1,500 requests issued at once and queued on those sockets. (Opening 1,500
// raw TCP connections at once is refused by the Windows accept backlog cap,
// which is exactly why production puts a proxy with pooled connections in front.)
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

const fire = (buyer, dealId) =>
  new Promise((resolve) => {
    const req = http.request(
      `${base}/api/deals/${dealId}/reserve`,
      { method: 'POST', agent, headers: { ...buyer.auth } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    // Network failures are counted (status 0), never thrown, so the test reports them.
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    req.end();
  });

test('1,500 distinct buyers racing for 100 units → exactly 100 pending orders, 0 oversell, 0 errors', async () => {
  const STOCK = 100;
  const BUYERS = 1500;
  const deal = await makeDeal({ stock: STOCK });
  const buyers = Array.from({ length: BUYERS }, syntheticBuyer);

  const results = await Promise.all(buyers.map((b) => fire(b, deal._id)));
  const count = (s) => results.filter((r) => r.status === s).length;

  assert.equal(count(202), STOCK, 'admitted exactly the stock');
  assert.equal(count(409), BUYERS - STOCK, 'everyone else told SOLD_OUT');
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SOLD_OUT'));
  assert.equal(results.filter((r) => r.status >= 500 || r.status === 0).length, 0, 'no server or network errors');

  assert.equal(await drainQueue(), STOCK);

  const db = await Deal.findById(deal._id);
  assert.equal(await Order.countDocuments({ deal: deal._id, status: 'PENDING_PAYMENT' }), STOCK);
  assert.equal(db.remainingStock, 0);
  assert.equal(db.soldCount, STOCK);
  assert.equal(await getRedis().hget(keys.deal(deal._id), 'stock'), '0');
  const distinctUsers = await Order.distinct('user', { deal: deal._id });
  assert.equal(distinctUsers.length, STOCK, 'one unit per user');
});

test('one user spamming 25 parallel clicks gets exactly one reservation', async () => {
  const deal = await makeDeal({ stock: 10 });
  const buyer = syntheticBuyer();
  const results = await Promise.all(Array.from({ length: 25 }, () => fire(buyer, deal._id)));
  const ok = results.filter((r) => r.status === 202 || r.status === 200);
  const ids = new Set(ok.map((r) => r.body.reservationId));
  assert.equal(ids.size, 1, 'all successful responses carry the same reservation');
  assert.equal(results.filter((r) => r.status === 202).length, 1, 'only one request created work');
  // The rest are either idempotent 200s or rate-limited 429s — never errors.
  assert.ok(results.every((r) => [200, 202, 429].includes(r.status)));
  await drainQueue();
  assert.equal(await Order.countDocuments({ deal: deal._id }), 1);
  assert.equal((await Deal.findById(deal._id)).remainingStock, 9);
});
