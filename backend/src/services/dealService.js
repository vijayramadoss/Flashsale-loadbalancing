import mongoose from 'mongoose';
import { Deal } from '../models/Deal.js';
import { Product, variantLabel } from '../models/Product.js';
import { ACTIVE_STATUSES, Order } from '../models/Order.js';
import { getRedis, keys, ORDER_GROUP } from '../lib/redis.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { invalidateCatalogCache } from './catalogService.js';
import { discountPct } from './pricing.js';

export const isObjectId = (id) => mongoose.isValidObjectId(id) && String(new mongoose.Types.ObjectId(id)) === String(id);

function dealState({ stock, startsAt, endsAt }, now) {
  if (now >= endsAt) return 'ENDED';
  if (now < startsAt) return 'UPCOMING';
  if (stock <= 0) return 'SOLD_OUT';
  return 'LIVE';
}

/**
 * Copies a deal from MongoDB into Redis (see the PRIME Lua script for the
 * atomicity rules). On a cache miss — first use, or Redis lost its data — the
 * token count is rebuilt from the durable Mongo counter and the buyer list
 * from active orders, so previous winners still cannot win twice.
 */
export async function primeDeal(dealDoc) {
  const deal = dealDoc.product?.name ? dealDoc : await Deal.findById(dealDoc._id).populate('product');
  const variant = deal.product.variants.find((v) => v.sku === deal.sku);
  const orders = await Order.find({ deal: deal._id, status: { $in: ACTIVE_STATUSES } }, { user: 1, reservationId: 1 }).lean();
  const buyers = Object.fromEntries(orders.map((o) => [o.user.toString(), o.reservationId]));
  const meta = {
    total: String(deal.totalStock),
    startsAt: String(deal.startsAt.getTime()),
    endsAt: String(deal.endsAt.getTime()),
    title: deal.title,
    dealPriceCents: String(deal.dealPriceCents),
    mrpCents: String(deal.mrpCents),
    holdMinutes: String(deal.holdMinutes),
    sku: deal.sku,
    slug: deal.product.slug,
    brand: deal.product.brand,
    productName: deal.product.name,
    design: deal.product.design,
    variantLabel: variant ? variantLabel(variant) : deal.sku,
    colorHex: variant?.colorHex || '#888888',
  };
  return getRedis().fsPrime(keys.deal(deal._id), keys.buyers(deal._id), String(deal.remainingStock), JSON.stringify(meta), JSON.stringify(buyers));
}

async function loadDealHash(dealId) {
  if (!isObjectId(dealId)) throw notFound('Deal not found');
  const redis = getRedis();
  let hash = await redis.hgetall(keys.deal(dealId));
  if (!hash.startsAt) {
    const deal = await Deal.findById(dealId).populate('product');
    if (!deal) throw notFound('Deal not found');
    await primeDeal(deal);
    hash = await redis.hgetall(keys.deal(dealId));
  }
  return hash;
}

/** Public deal status — one Redis HGETALL, so 100k pollers never touch MongoDB. */
export async function getDealStatus(dealId) {
  const h = await loadDealHash(dealId);
  const now = Date.now();
  const s = { stock: Number(h.stock), startsAt: Number(h.startsAt), endsAt: Number(h.endsAt) };
  const dealPriceCents = Number(h.dealPriceCents);
  const mrpCents = Number(h.mrpCents);
  return {
    id: String(dealId),
    title: h.title,
    product: { slug: h.slug, brand: h.brand, name: h.productName, design: h.design, sku: h.sku, variantLabel: h.variantLabel, colorHex: h.colorHex },
    dealPriceCents,
    mrpCents,
    discountPct: discountPct(dealPriceCents, mrpCents),
    holdMinutes: Number(h.holdMinutes),
    totalStock: Number(h.total),
    remainingStock: Math.max(0, s.stock),
    startsAt: new Date(s.startsAt).toISOString(),
    endsAt: new Date(s.endsAt).toISOString(),
    state: dealState(s, now),
    serverTime: new Date(now).toISOString(),
  };
}

// Per-process 2-second micro-cache (a cache, never the source of truth → stateless-safe).
let listCache = { at: 0, value: null };
export async function listOpenDeals() {
  if (listCache.value && Date.now() - listCache.at < 2000) return listCache.value;
  const deals = await Deal.find({ endsAt: { $gt: new Date() } }, { _id: 1 }).sort({ startsAt: 1 }).limit(10).lean();
  const value = await Promise.all(deals.map((d) => getDealStatus(d._id.toString())));
  listCache = { at: Date.now(), value };
  return value;
}

export const clearDealListCache = () => {
  listCache = { at: 0, value: null };
};

// ---------- admin ----------

export async function createDeal({ sku, title, dealPriceCents, totalStock, startsAt, endsAt, holdMinutes = 10 }) {
  const product = await Product.findOne({ 'variants.sku': sku });
  if (!product) throw badRequest('Unknown SKU', [{ field: 'sku', message: 'No product variant has this SKU' }]);
  const variant = product.variants.find((v) => v.sku === sku);
  if (dealPriceCents >= variant.priceCents) {
    throw badRequest('Deal price must be below the regular price', [{ field: 'dealPriceCents', message: 'Must be lower than the current price' }]);
  }
  const deal = await Deal.create({
    product: product._id,
    sku,
    title,
    startsAt,
    endsAt,
    totalStock,
    remainingStock: totalStock,
    dealPriceCents,
    mrpCents: variant.mrpCents,
    holdMinutes,
  });
  deal.product = product;
  await primeDeal(deal);
  clearDealListCache();
  await invalidateCatalogCache();
  return deal;
}

export async function listAllDeals() {
  return Deal.find().populate('product', 'name brand slug').sort({ startsAt: -1 }).limit(50).lean();
}

/**
 * Consistency dashboard: the fast Redis counters vs the durable MongoDB state.
 * Invariants: active orders == totalStock - remainingStock == soldCount, and never > totalStock.
 */
export async function getDealStats(dealId) {
  if (!isObjectId(dealId)) throw notFound('Deal not found');
  const deal = await Deal.findById(dealId).populate('product', 'name');
  if (!deal) throw notFound('Deal not found');
  const redis = getRedis();
  const [stock, holders, byStatus, backlog, pending] = await Promise.all([
    redis.hget(keys.deal(dealId), 'stock'),
    redis.hlen(keys.buyers(dealId)),
    Order.aggregate([{ $match: { deal: deal._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    redis.xlen(keys.orderStream()),
    redis.xpending(keys.orderStream(), ORDER_GROUP).catch(() => [0]),
  ]);
  const count = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const active = ACTIVE_STATUSES.reduce((n, s) => n + (count[s] || 0), 0);
  const held = deal.totalStock - deal.remainingStock;
  return {
    id: deal._id.toString(),
    title: deal.title,
    productName: deal.product?.name,
    sku: deal.sku,
    dealPriceCents: deal.dealPriceCents,
    startsAt: deal.startsAt,
    endsAt: deal.endsAt,
    totalStock: deal.totalStock,
    orders: {
      pendingPayment: count.PENDING_PAYMENT || 0,
      paid: (count.CONFIRMED || 0) + (count.SHIPPED || 0) + (count.DELIVERED || 0),
      expired: count.EXPIRED || 0,
      cancelled: count.CANCELLED || 0,
    },
    mongo: { remainingStock: deal.remainingStock, soldCount: deal.soldCount },
    redis: { remainingTokens: stock === null ? null : Number(stock), reservationHolders: holders },
    // Processed messages are deleted, so the stream length is the unprocessed backlog (all deals).
    queue: { backlog, pendingUnacked: Number(pending?.[0] ?? 0) },
    consistency: {
      oversold: active > deal.totalStock,
      countersMatchOrders: held === active && deal.soldCount === active,
    },
  };
}

/** Demo/QA helper: removes a deal's orders and restores its stock. Refused in production. */
export async function resetDeal(dealId, { startsAt, endsAt } = {}, { isProduction }) {
  if (isProduction) throw new AppError(403, 'FORBIDDEN', 'Deal reset is disabled in production');
  if (!isObjectId(dealId)) throw notFound('Deal not found');
  const deal = await Deal.findById(dealId).populate('product');
  if (!deal) throw notFound('Deal not found');
  const pending = await getRedis().xpending(keys.orderStream(), ORDER_GROUP).catch(() => [0]);
  if (Number(pending?.[0] ?? 0) > 0) throw new AppError(409, 'QUEUE_BUSY', 'Reservations are still being processed — retry when the queue is empty');
  await Order.deleteMany({ deal: deal._id });
  deal.remainingStock = deal.totalStock;
  deal.soldCount = 0;
  if (startsAt) deal.startsAt = startsAt;
  if (endsAt) deal.endsAt = endsAt;
  await deal.save();
  await getRedis().del(keys.deal(dealId), keys.buyers(dealId));
  await primeDeal(deal);
  clearDealListCache();
  await invalidateCatalogCache();
  return getDealStats(dealId);
}
