import mongoose from 'mongoose';
import { FlashSale } from '../models/FlashSale.js';
import { Product } from '../models/Product.js';
import { Order } from '../models/Order.js';
import { getRedis, keys, ORDER_GROUP } from '../lib/redis.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';

export const isObjectId = (id) => mongoose.isValidObjectId(id) && String(new mongoose.Types.ObjectId(id)) === id;

function saleState({ stock, startsAt, endsAt }, now) {
  if (now >= endsAt) return 'ENDED';
  if (now < startsAt) return 'UPCOMING';
  if (stock <= 0) return 'SOLD_OUT';
  return 'LIVE';
}

/**
 * Copies a sale from MongoDB into Redis (see PRIME script for the atomicity
 * rules). If the Redis key is missing — first use, or Redis lost its data —
 * stock is rebuilt from the durable Mongo counter and the buyer list from
 * existing orders, so previous buyers still cannot buy twice.
 */
export async function primeSale(saleDoc) {
  const sale = saleDoc.product?.name ? saleDoc : await FlashSale.findById(saleDoc._id).populate('product');
  const orders = await Order.find({ sale: sale._id }, { user: 1, reservationId: 1 }).lean();
  const buyers = Object.fromEntries(orders.map((o) => [o.user.toString(), o.reservationId]));
  const meta = {
    total: String(sale.totalStock),
    startsAt: String(sale.startsAt.getTime()),
    endsAt: String(sale.endsAt.getTime()),
    title: sale.title,
    priceCents: String(sale.priceCents),
    currency: sale.product.currency,
    productName: sale.product.name,
    description: sale.product.description,
    imageUrl: sale.product.imageUrl,
  };
  return getRedis().fsPrime(keys.sale(sale._id), keys.buyers(sale._id), String(sale.remainingStock), JSON.stringify(meta), JSON.stringify(buyers));
}

/** Loads the Redis copy of a sale, priming it from Mongo on a cache miss. */
async function loadSaleHash(saleId) {
  if (!isObjectId(saleId)) throw notFound('Sale not found');
  const redis = getRedis();
  let hash = await redis.hgetall(keys.sale(saleId));
  if (!hash.startsAt) {
    const sale = await FlashSale.findById(saleId).populate('product');
    if (!sale) throw notFound('Sale not found');
    await primeSale(sale);
    hash = await redis.hgetall(keys.sale(saleId));
  }
  return hash;
}

/**
 * Public sale status. Served entirely from Redis (one HGETALL), so 100k
 * clients polling it never touch MongoDB.
 */
export async function getSaleStatus(saleId) {
  const h = await loadSaleHash(saleId);
  const now = Date.now();
  const s = { stock: Number(h.stock), startsAt: Number(h.startsAt), endsAt: Number(h.endsAt) };
  return {
    id: saleId,
    title: h.title,
    product: { name: h.productName, description: h.description, imageUrl: h.imageUrl },
    priceCents: Number(h.priceCents),
    currency: h.currency,
    totalStock: Number(h.total),
    remainingStock: Math.max(0, s.stock),
    startsAt: new Date(s.startsAt).toISOString(),
    endsAt: new Date(s.endsAt).toISOString(),
    state: saleState(s, now),
    serverTime: new Date(now).toISOString(),
  };
}

// Tiny per-process micro-cache for the sale list. It is safe in a stateless
// cluster because it is only a cache (max 2 s stale), never the source of truth.
let listCache = { at: 0, value: null };
export async function listOpenSales() {
  if (listCache.value && Date.now() - listCache.at < 2000) return listCache.value;
  const sales = await FlashSale.find({ endsAt: { $gt: new Date() } }, { title: 1, startsAt: 1, endsAt: 1 })
    .sort({ startsAt: 1 })
    .limit(20)
    .lean();
  const value = sales.map((s) => ({ id: s._id.toString(), title: s.title, startsAt: s.startsAt, endsAt: s.endsAt }));
  listCache = { at: Date.now(), value };
  return value;
}

export function clearSaleListCache() {
  listCache = { at: 0, value: null };
}

// ---------- admin ----------

export async function createSale({ productId, product, title, startsAt, endsAt, totalStock }) {
  let productDoc;
  if (productId) {
    productDoc = isObjectId(productId) ? await Product.findById(productId) : null;
    if (!productDoc) throw notFound('Product not found');
  } else if (product) {
    productDoc = await Product.create(product);
  } else {
    throw badRequest('Provide productId or product');
  }
  const sale = await FlashSale.create({
    product: productDoc._id,
    title,
    startsAt,
    endsAt,
    totalStock,
    remainingStock: totalStock,
    priceCents: productDoc.priceCents,
  });
  sale.product = productDoc;
  await primeSale(sale);
  clearSaleListCache();
  return sale;
}

export async function listAllSales() {
  return FlashSale.find().populate('product', 'name priceCents').sort({ startsAt: -1 }).limit(50).lean();
}

/**
 * Consistency dashboard: compares the fast Redis counters with the durable
 * MongoDB state. After the queue drains these must agree:
 *   redis tokens taken  ==  confirmed orders  ==  totalStock - remainingStock
 */
export async function getSaleStats(saleId) {
  if (!isObjectId(saleId)) throw notFound('Sale not found');
  const sale = await FlashSale.findById(saleId).populate('product', 'name');
  if (!sale) throw notFound('Sale not found');
  const redis = getRedis();
  const [stock, buyers, orders, queueLength, pending] = await Promise.all([
    redis.hget(keys.sale(saleId), 'stock'),
    redis.hlen(keys.buyers(saleId)),
    Order.countDocuments({ sale: sale._id }),
    redis.xlen(keys.orderStream()),
    redis.xpending(keys.orderStream(), ORDER_GROUP).catch(() => [0]),
  ]);
  const redisStock = stock === null ? null : Number(stock);
  const sold = sale.totalStock - sale.remainingStock;
  return {
    id: sale._id.toString(),
    title: sale.title,
    productName: sale.product?.name,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    totalStock: sale.totalStock,
    mongo: { remainingStock: sale.remainingStock, soldCount: sale.soldCount, confirmedOrders: orders },
    redis: { remainingTokens: redisStock, reservationHolders: buyers },
    // Processed messages are deleted, so the stream length is the unprocessed backlog (all sales).
    queue: { backlog: queueLength, pendingUnacked: Number(pending?.[0] ?? 0) },
    consistency: {
      oversold: orders > sale.totalStock,
      // The Mongo counters and the actual order documents must tell the same story.
      countersMatchOrders: sold === orders && sale.soldCount === orders,
    },
  };
}

/**
 * Demo/QA helper: wipes orders for one sale and restores its stock so the
 * sale can be replayed. Refused in production because it deletes order data.
 */
export async function resetSale(saleId, { startsAt, endsAt } = {}, { isProduction }) {
  if (isProduction) throw new AppError(403, 'FORBIDDEN', 'Sale reset is disabled in production');
  if (!isObjectId(saleId)) throw notFound('Sale not found');
  const sale = await FlashSale.findById(saleId).populate('product');
  if (!sale) throw notFound('Sale not found');
  const pending = await getRedis().xpending(keys.orderStream(), ORDER_GROUP).catch(() => [0]);
  if (Number(pending?.[0] ?? 0) > 0) {
    throw new AppError(409, 'QUEUE_BUSY', 'Orders are still being processed — retry when the queue is empty');
  }
  await Order.deleteMany({ sale: sale._id });
  sale.remainingStock = sale.totalStock;
  sale.soldCount = 0;
  if (startsAt) sale.startsAt = startsAt;
  if (endsAt) sale.endsAt = endsAt;
  await sale.save();
  await getRedis().del(keys.sale(saleId), keys.buyers(saleId));
  await primeSale(sale);
  clearSaleListCache();
  return getSaleStats(saleId);
}
