// Seeds a demo environment:
//   * the admin account (ADMIN_EMAIL / ADMIN_PASSWORD from backend/.env)
//   * a demo smartphone product
//   * a 500-unit flash sale starting a few minutes from now
//
// Usage:  npm run seed -- [--starts-in-min=2] [--stock=500] [--duration-min=60]
import bcrypt from 'bcryptjs';
import { config } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, waitForRedis, getRedis } from '../src/lib/redis.js';
import { User } from '../src/models/User.js';
import { Product } from '../src/models/Product.js';
import { createSale } from '../src/services/saleService.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const startsInMin = arg('starts-in-min', 2);
const stock = arg('stock', 500);
const durationMin = arg('duration-min', 60);

if (!config.adminPassword || config.adminPassword.length < 8) {
  console.error('Set ADMIN_PASSWORD (min 8 chars) in backend/.env before seeding.');
  process.exit(1);
}

await connectMongo();
await waitForRedis(getRedis());
await Promise.all([User.init(), Product.init()]); // make sure unique indexes exist

const existingAdmin = await User.findOne({ email: config.adminEmail });
if (existingAdmin) {
  console.log(`Admin ${config.adminEmail} already exists (password unchanged).`);
} else {
  await User.create({
    name: 'Sale Admin',
    email: config.adminEmail,
    passwordHash: await bcrypt.hash(config.adminPassword, config.bcryptRounds),
    role: 'admin',
  });
  console.log(`Created admin ${config.adminEmail} (password from ADMIN_PASSWORD in backend/.env).`);
}

let product = await Product.findOne({ name: 'Nova X1 5G Smartphone' });
if (!product) {
  product = await Product.create({
    name: 'Nova X1 5G Smartphone',
    description: '6.7" AMOLED, 256 GB storage, 5000 mAh battery. Festival flash-sale price — one per customer.',
    imageUrl: '/phone.svg',
    priceCents: 2499900,
    currency: 'INR',
  });
}

const startsAt = new Date(Date.now() + startsInMin * 60_000);
const sale = await createSale({
  productId: product._id.toString(),
  title: 'Festival Flash Sale',
  startsAt,
  endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
  totalStock: stock,
});
console.log(`Created sale ${sale._id} — ${stock} units, starts ${startsAt.toLocaleString()}.`);

await closeRedis();
await disconnectMongo();
