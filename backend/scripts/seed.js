// Seeds a demo store:
//   * the admin account (ADMIN_EMAIL / ADMIN_PASSWORD from backend/.env)
//   * the phone catalog (scripts/catalog-data.js) — upserted by slug
//   * a 500-unit flash deal that starts a few minutes from now
//
// Usage:  npm run seed -- [--starts-in-min=2] [--stock=500] [--duration-min=60] [--fresh]
//   --fresh  deletes ALL products, deals and orders (users are kept) and clears
//            this environment's Redis keys first. Refused when NODE_ENV=production.
import bcrypt from 'bcryptjs';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, waitForRedis, getRedis } from '../src/lib/redis.js';
import { User } from '../src/models/User.js';
import { Product } from '../src/models/Product.js';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';
import { createDeal } from '../src/services/dealService.js';
import { invalidateCatalogCache } from '../src/services/catalogService.js';
import { catalog } from './catalog-data.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const fresh = process.argv.includes('--fresh');
const startsInMin = arg('starts-in-min', 2);
const stock = arg('stock', 500);
const durationMin = arg('duration-min', 60);

if (!config.adminPassword || config.adminPassword.length < 8) {
  console.error('Set ADMIN_PASSWORD (min 8 chars) in backend/.env before seeding.');
  process.exit(1);
}
if (fresh && config.isProduction) {
  console.error('--fresh is refused in production.');
  process.exit(1);
}

await connectMongo();
await waitForRedis(getRedis());

if (fresh) {
  const db = (await import('mongoose')).default.connection.db;
  for (const name of ['products', 'deals', 'orders', 'flashsales']) await db.dropCollection(name).catch(() => {});
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${config.redisPrefix}*`, 'COUNT', 500);
    if (found.length) await redis.del(...found);
    cursor = next;
  } while (cursor !== '0');
  console.log('Fresh start: dropped products, deals and orders; cleared Redis keys for this environment.');
}

// Create missing indexes and drop ones left over from older schema versions.
for (const m of [User, Product, Deal, Order]) await m.syncIndexes();

if (await User.exists({ email: config.adminEmail })) {
  console.log(`Admin ${config.adminEmail} already exists (password unchanged).`);
} else {
  await User.create({
    name: 'Store Admin',
    email: config.adminEmail,
    passwordHash: await bcrypt.hash(config.adminPassword, config.bcryptRounds),
    role: 'admin',
  });
  console.log(`Created admin ${config.adminEmail} (password from ADMIN_PASSWORD in backend/.env).`);
}

let created = 0;
for (const p of catalog) {
  if (await Product.exists({ slug: p.slug })) continue;
  await Product.create(p);
  created++;
}
console.log(`Catalog: ${created} products created, ${catalog.length - created} already present.`);
await invalidateCatalogCache();

const deal = await Deal.findOne({ endsAt: { $gt: new Date() } });
if (deal && !fresh) {
  console.log(`An open deal already exists (${deal._id}); not creating another.`);
} else {
  const product = await Product.findOne({ slug: 'oneplus-13' });
  const variant = product.variants.find((v) => v.storage === '256 GB' && v.color === 'Black Eclipse');
  const startsAt = new Date(Date.now() + startsInMin * 60_000);
  const d = await createDeal({
    sku: variant.sku,
    title: 'Festival Flash Deal',
    dealPriceCents: 4999900,
    totalStock: stock,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
    holdMinutes: 10,
  });
  console.log(`Created deal ${d._id}: ${product.name} (${variant.sku}) — ${stock} units at ₹49,999, starts ${startsAt.toLocaleString()}.`);
}

await closeRedis();
await disconnectMongo();
