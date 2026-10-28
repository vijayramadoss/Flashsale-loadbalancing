import mongoose from 'mongoose';
import { Deal } from '../models/Deal.js';
import { Order } from '../models/Order.js';
import { Product, variantLabel } from '../models/Product.js';
import { getRedis, keys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { newOrderNumber } from './orderService.js';
import { priceOrder } from './pricing.js';

/**
 * Turns ONE queued flash-deal reservation into a durable PENDING_PAYMENT order.
 *
 * Runs inside a MongoDB multi-document ACID transaction:
 *   1. idempotency — has this reservation already become an order?
 *   2. conditional atomic decrement — the Mongo equivalent of
 *        UPDATE deal SET stock = stock - 1 WHERE id = :id AND stock > 0
 *      If nothing matches, the DB itself says "sold out" and nothing is written.
 *   3. insert the order (unique reservationId; unique activeDealKey = one per customer).
 *
 * Even if Redis admitted too many reservations (lost data, bug), step 2 makes
 * overselling impossible. The customer then has `holdMinutes` (counted from
 * the moment Redis admitted them) to enter an address and pay.
 *
 * @returns {{status:'RESERVED', orderId:string} | {status:'FAILED', reason:string}}
 */
export async function persistReservation({ reservationId, dealId, userId, createdAt }) {
  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      const existing = await Order.findOne({ reservationId }, { _id: 1 }).session(session);
      if (existing) {
        outcome = { status: 'RESERVED', orderId: existing._id.toString() };
        return;
      }
      const deal = await Deal.findOneAndUpdate(
        { _id: dealId, remainingStock: { $gt: 0 } },
        { $inc: { remainingStock: -1, soldCount: 1 } },
        { new: true, session },
      );
      if (!deal) {
        outcome = { status: 'FAILED', reason: 'SOLD_OUT' };
        return;
      }
      const product = await Product.findById(deal.product, { slug: 1, brand: 1, name: 1, design: 1, variants: 1 }).session(session).lean();
      const variant = product.variants.find((v) => v.sku === deal.sku);
      const items = [
        {
          product: product._id,
          slug: product.slug,
          sku: deal.sku,
          brand: product.brand,
          name: product.name,
          variantLabel: variant ? variantLabel(variant) : deal.sku,
          colorHex: variant?.colorHex,
          design: product.design,
          qty: 1,
          unitPriceCents: deal.dealPriceCents,
          mrpCents: deal.mrpCents,
        },
      ];
      const admittedAt = Number(createdAt) || Date.now();
      const [order] = await Order.create(
        [
          {
            orderNumber: newOrderNumber(),
            user: userId,
            type: 'DEAL',
            deal: deal._id,
            reservationId,
            activeDealKey: `${deal._id}:${userId}`,
            items,
            pricing: priceOrder(items, 'STANDARD'),
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(admittedAt + deal.holdMinutes * 60_000),
            history: [{ status: 'PENDING_PAYMENT', note: `Flash-deal unit reserved — complete checkout within ${deal.holdMinutes} min` }],
          },
        ],
        { session },
      );
      outcome = { status: 'RESERVED', orderId: order._id.toString() };
    });
    return outcome;
  } catch (err) {
    // Unique activeDealKey: the customer already holds an active order for this
    // deal under another reservation. The transaction rolled back (stock untouched).
    if (err.code === 11000 && /activeDealKey/.test(err.message)) return { status: 'FAILED', reason: 'ALREADY_PURCHASED' };
    throw err;
  } finally {
    await session.endSession();
  }
}

/** Writes the outcome back to Redis so the polling endpoint can see it. */
export async function publishOutcome(job, outcome) {
  const redis = getRedis();
  if (outcome.status === 'RESERVED') {
    await redis.hset(keys.reservation(job.reservationId), 'status', 'RESERVED', 'orderId', outcome.orderId);
    return;
  }
  //  SOLD_OUT          → Mongo has no stock: don't return the token; zero Redis stock so no more doomed admissions.
  //  ALREADY_PURCHASED → return the token, keep the customer marked as a buyer.
  //  anything else     → processing kept failing: return the token and let the customer retry.
  const restock = outcome.reason === 'SOLD_OUT' ? '0' : '1';
  const freeSlot = outcome.reason === 'ALREADY_PURCHASED' ? '0' : '1';
  await redis.fsRelease(keys.deal(job.dealId), keys.buyers(job.dealId), keys.reservation(job.reservationId), job.userId, job.reservationId, outcome.reason, restock, freeSlot);
  if (outcome.reason === 'SOLD_OUT') await redis.hset(keys.deal(job.dealId), 'stock', '0');
  logger.warn('reservation failed', { reservationId: job.reservationId, dealId: job.dealId, reason: outcome.reason });
}

/** Converts a raw stream entry [id, [k1, v1, k2, v2...]] into a job object. */
export function parseStreamEntry([id, fields]) {
  const job = { messageId: id };
  for (let i = 0; i < fields.length; i += 2) job[fields[i]] = fields[i + 1];
  return job;
}
