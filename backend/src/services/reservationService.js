import { randomUUID } from 'node:crypto';
import { getRedis, keys } from '../lib/redis.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { Order } from '../models/Order.js';
import { Deal } from '../models/Deal.js';
import { isObjectId, primeDeal } from './dealService.js';

const RESERVATION_TTL_SEC = 24 * 60 * 60;

/**
 * Flash-deal admission ("Buy now" on a deal). Runs ONE Lua script in Redis
 * and returns immediately; the pending order is written later by the queue
 * worker. No MongoDB access on the hot path.
 */
export async function reserve(userId, dealId) {
  if (!isObjectId(dealId)) throw notFound('Deal not found');
  const redis = getRedis();
  const reservationId = randomUUID();
  const run = () =>
    redis.fsReserve(keys.deal(dealId), keys.buyers(dealId), keys.orderStream(), keys.reservation(reservationId), userId, reservationId, dealId, RESERVATION_TTL_SEC);

  let [outcome, id, remaining] = await run();
  if (outcome === 'NO_SALE') {
    // Cache miss (never primed, or Redis was flushed): load from Mongo once.
    const deal = await Deal.findById(dealId).populate('product');
    if (!deal) throw notFound('Deal not found');
    await primeDeal(deal);
    [outcome, id, remaining] = await run();
  }

  switch (outcome) {
    case 'OK':
      return { reservationId: id, status: 'QUEUED', duplicate: false, remaining: Number(remaining) };
    case 'DUPLICATE': {
      // Same customer again: return the reservation (and order) they already hold.
      const existing = await getReservation(id, userId).catch(() => ({ status: 'QUEUED' }));
      return { reservationId: id, status: existing.status, orderId: existing.orderId, duplicate: true };
    }
    case 'NOT_STARTED':
      throw conflict('DEAL_NOT_STARTED', 'This deal has not started yet');
    case 'ENDED':
      throw conflict('DEAL_ENDED', 'This deal has ended');
    case 'SOLD_OUT':
      throw conflict('SOLD_OUT', 'Sorry — every unit in this deal has been claimed');
    default:
      throw new AppError(500, 'INTERNAL_ERROR', 'Unexpected reservation outcome');
  }
}

/**
 * Reservation status for polling: QUEUED → RESERVED (pending order created,
 * with orderId) or FAILED (with reason). Other users' ids are "not found".
 */
export async function getReservation(reservationId, userId) {
  const r = await getRedis().hgetall(keys.reservation(reservationId));
  if (r.userId) {
    if (r.userId !== userId) throw notFound('Reservation not found');
    return { reservationId, dealId: r.dealId, status: r.status, orderId: r.orderId || undefined, reason: r.reason || undefined };
  }
  const order = await Order.findOne({ reservationId }, { user: 1, deal: 1 }).lean();
  if (!order || order.user.toString() !== userId) throw notFound('Reservation not found');
  return { reservationId, dealId: order.deal.toString(), status: 'RESERVED', orderId: order._id.toString() };
}
