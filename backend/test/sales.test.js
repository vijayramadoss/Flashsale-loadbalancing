import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getRedis, keys } from '../src/lib/redis.js';
import { setup, teardown, resetData, makeUser, makeSale } from './helpers.js';

const app = createApp();

before(setup);
after(teardown);
beforeEach(resetData);

const newSaleBody = () => ({
  title: 'Diwali Drop',
  startsAt: new Date(Date.now() + 60_000).toISOString(),
  endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  totalStock: 500,
  product: { name: 'Nova X1', priceCents: 2499900 },
});

test('admin can create a sale; it is primed into Redis with the full stock', async () => {
  const { auth } = await makeUser({ role: 'admin' });
  const res = await request(app).post('/api/admin/sales').set(auth).send(newSaleBody());
  assert.equal(res.status, 201);
  const { id } = res.body.sale;
  assert.equal(res.body.sale.totalStock, 500);
  assert.equal(await getRedis().hget(keys.sale(id), 'stock'), '500');
});

test('only admins can use admin endpoints', async () => {
  const { auth } = await makeUser();
  assert.equal((await request(app).post('/api/admin/sales').send(newSaleBody())).status, 401);
  assert.equal((await request(app).post('/api/admin/sales').set(auth).send(newSaleBody())).status, 403);
  assert.equal((await request(app).get('/api/admin/sales').set(auth)).status, 403);
});

test('sale creation is validated on the server', async () => {
  const { auth } = await makeUser({ role: 'admin' });
  const body = { ...newSaleBody(), endsAt: new Date(Date.now() - 1000).toISOString(), totalStock: 0 };
  const res = await request(app).post('/api/admin/sales').set(auth).send(body);
  assert.equal(res.status, 400);
  const fields = res.body.error.details.map((d) => d.field);
  assert.ok(fields.includes('totalStock'));
});

test('public sale status is served from Redis and reports state + server time', async () => {
  const upcoming = await makeSale({ stock: 5, startsInMs: 60_000 });
  const res = await request(app).get(`/api/sales/${upcoming._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.sale.state, 'UPCOMING');
  assert.equal(res.body.sale.remainingStock, 5);
  assert.ok(Date.parse(res.body.sale.serverTime));
  assert.match(res.headers['cache-control'], /max-age=1/);

  const live = await makeSale({ stock: 5 });
  assert.equal((await request(app).get(`/api/sales/${live._id}`)).body.sale.state, 'LIVE');

  const list = await request(app).get('/api/sales');
  assert.equal(list.body.sales.length, 2);
});

test('unknown or malformed sale ids return 404', async () => {
  assert.equal((await request(app).get('/api/sales/not-an-id')).status, 404);
  assert.equal((await request(app).get('/api/sales/650000000000000000000000')).status, 404);
});

test('sale status re-primes itself from MongoDB if the Redis copy is lost', async () => {
  const sale = await makeSale({ stock: 7 });
  await getRedis().del(keys.sale(sale._id));
  const res = await request(app).get(`/api/sales/${sale._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.sale.remainingStock, 7);
});
