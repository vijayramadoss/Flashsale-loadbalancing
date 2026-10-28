import mongoose from 'mongoose';
import { FlashSale } from '../models/FlashSale.js';
import { Order } from '../models/Order.js';
import { getRedis, keys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Turns ONE queued reservation into a durable order.
 *
 * Runs inside a MongoDB multi-document ACID transaction:
 *   1. idempotency check  — has this reservation already become an order?
 *   2. conditional atomic decrement — the Mongo equivalent of
 *        UPDATE sale SET stock = stock - 1 WHERE id = :id AND stock > 0
 *      If no document matches, the DB itself says "sold out" and nothing is written.
 *   3. insert the order (unique indexes on reservationId and on (sale,user)).
 * Either both writes commit or neither does.
 *
 * Even if Redis somehow admitted too many reservations (e.g. its data was
 * lost and rebuilt incorrectly), step 2 makes overselling impossible.
 *
 * @returns {{status: 'CONFIRMED', orderId: string} | {status: 'FAILED', reason: string}}
 */
export async function persistReservation({ reservationId, saleId, userId }) {
  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      const existing = await Order.findOne({ reservationId }, { _id: 1 }).session(session);
      if (existing) {
        outcome = { status: 'CONFIRMED', orderId: existing._id.toString() };
        return;
      }
      const sale = await FlashSale.findOneAndUpdate(
        { _id: saleId, remainingStock: { $gt: 0 } },
        { $inc: { remainingStock: -1, soldCount: 1 } },
        { new: true, session, projection: { product: 1, priceCents: 1 } },
      );
      if (!sale) {
        outcome = { status: 'FAILED', reason: 'SOLD_OUT' };
        return;
      }
      const [order] = await Order.create(
        [{ reservationId, sale: sale._id, product: sale.product, user: userId, priceCents: sale.priceCents }],
        { session },
      );
      outcome = { status: 'CONFIRMED', orderId: order._id.toString() };
    });
    return outcome;
  } catch (err) {
    // Unique (sale,user) violation: this user already owns an order for this
    // sale under a different reservation. The transaction was rolled back, so
    // the Mongo stock is untouched.
    if (err.code === 11000 && /sale_1_user_1/.test(err.message)) {
      return { status: 'FAILED', reason: 'ALREADY_PURCHASED' };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/** Writes the final outcome back to Redis so the polling endpoint can see it. */
export async function publishOutcome(job, outcome) {
  const redis = getRedis();
  if (outcome.status === 'CONFIRMED') {
    await redis.hset(keys.reservation(job.reservationId), 'status', 'CONFIRMED', 'orderId', outcome.orderId);
    return;
  }
  // FAILED: decide how to compensate the Redis side.
  //  SOLD_OUT          → Mongo has no stock left: don't return the token, and zero Redis stock
  //                      so no further (doomed) reservations are admitted.
  //  ALREADY_PURCHASED → the user already has an order: return the token, keep them marked as a buyer.
  //  anything else     → processing kept failing: return the token and let the user try again.
  const restock = outcome.reason === 'SOLD_OUT' ? '0' : '1';
  const freeSlot = outcome.reason === 'ALREADY_PURCHASED' ? '0' : '1';
  await redis.fsRelease(
    keys.sale(job.saleId),
    keys.buyers(job.saleId),
    keys.reservation(job.reservationId),
    job.userId,
    job.reservationId,
    outcome.reason,
    restock,
    freeSlot,
  );
  if (outcome.reason === 'SOLD_OUT') await redis.hset(keys.sale(job.saleId), 'stock', '0');
  logger.warn('reservation failed', { ...job, reason: outcome.reason });
}

/** Converts a raw stream entry [id, [k1, v1, k2, v2...]] into a job object. */
export function parseStreamEntry([id, fields]) {
  const job = { messageId: id };
  for (let i = 0; i < fields.length; i += 2) job[fields[i]] = fields[i + 1];
  return job;
}
