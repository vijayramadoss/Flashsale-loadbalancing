import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Product } from '../src/models/Product.js';
import { setup, teardown, resetData, client, makeProduct, makeDeal } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

test('listing: filter by brand, search, sort by price, facets and pagination', async () => {
  await makeProduct({ brand: 'Alpha', name: 'Alpha One', priceCents: 3_000_000, mrpCents: 3_500_000 });
  await makeProduct({ brand: 'Alpha', name: 'Alpha Lite', priceCents: 1_000_000, mrpCents: 1_000_000 });
  await makeProduct({ brand: 'Beta', name: 'Beta Max', priceCents: 2_000_000, mrpCents: 2_500_000 });

  const all = await api.get('/api/products?sort=price_asc');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items.map((p) => p.name), ['Alpha Lite', 'Beta Max', 'Alpha One']);
  assert.deepEqual(all.body.facets.brands, [{ name: 'Alpha', count: 2 }, { name: 'Beta', count: 1 }]);
  assert.equal(all.body.items[2].discountPct, 14);

  const alpha = await api.get('/api/products?brand=Alpha&sort=price_desc');
  assert.deepEqual(alpha.body.items.map((p) => p.name), ['Alpha One', 'Alpha Lite']);

  const search = await api.get('/api/products?q=max');
  assert.deepEqual(search.body.items.map((p) => p.name), ['Beta Max']);

  const page2 = await api.get('/api/products?limit=2&page=2&sort=price_asc');
  assert.equal(page2.body.pages, 2);
  assert.deepEqual(page2.body.items.map((p) => p.name), ['Alpha One']);

  assert.equal((await api.get('/api/products?sort=bogus')).status, 400);
});

test('product detail exposes variants with stock levels (not exact counts) and any live deal', async () => {
  const p = await makeProduct({ stock: 3 });
  const deal = await makeDeal();
  const res = await api.get(`/api/products/${p.slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.product.variants.length, 2);
  assert.equal(res.body.product.variants[0].stockLevel, 'LOW');
  assert.equal(res.body.product.variants[0].stockLeft, 3);
  assert.equal(res.body.product.deal, null);

  const dealProduct = await Product.findById(deal.product);
  const withDeal = await api.get(`/api/products/${dealProduct.slug}`);
  assert.equal(withDeal.body.product.deal.id, deal._id.toString());
  assert.equal(withDeal.body.product.variants[0].stockLevel, 'IN');
  assert.equal(withDeal.body.product.variants[0].stockLeft, undefined);

  assert.equal((await api.get('/api/products/does-not-exist')).status, 404);
});

test('cart quote prices from the database and flags unavailable lines', async () => {
  const p = await makeProduct({ stock: 2, priceCents: 1_000_000, mrpCents: 1_200_000 });
  const [a, b] = p.variants;
  await Product.updateOne({ _id: p._id, 'variants.sku': b.sku }, { $set: { 'variants.$.stock': 0 } });

  const res = await api.post('/api/cart/quote', { items: [{ sku: a.sku, qty: 4 }, { sku: b.sku, qty: 1 }, { sku: 'NOPE-1-1', qty: 1 }], deliveryMethod: 'EXPRESS' });
  assert.equal(res.status, 200);
  const [l1, l2, l3] = res.body.lines;
  assert.equal(l1.issue, 'QTY_REDUCED');
  assert.equal(l1.qty, 2);
  assert.equal(l2.issue, 'OUT_OF_STOCK');
  assert.equal(l3.issue, 'NOT_FOUND');
  assert.equal(res.body.canCheckout, false);
  assert.deepEqual(res.body.pricing, { subtotalCents: 2_000_000, savingsCents: 400_000, deliveryCents: 14_900, totalCents: 2_014_900 });
});
