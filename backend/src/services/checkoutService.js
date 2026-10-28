import { randomUUID } from 'node:crypto';
import { getRedis, keys } from '../lib/redis.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { Order } from '../models/Order.js';
import { FlashSale } from '../models/FlashSale.js';
import { isObjectId, primeSale } from './saleService.js';

const RESERVATION_TTL_SEC = 24 * 60 * 60;

/**
 * Admission step of checkout. Runs ONE Lua script in Redis and returns
 * immediately; the order itself is written later by the queue worker.
 * No MongoDB access happens here on the hot path.
 *
 * @returns {{ reservationId: string, status: string, duplicate: boolean, remaining?: number }}
 */
export async function reserve(userId, saleId) {
  if (!isObjectId(saleId)) throw notFound('Sale not found');
  const redis = getRedis();
  const reservationId = randomUUID();
  const run = () =>
    redis.fsReserve(
      keys.sale(saleId),
      keys.buyers(saleId),
      keys.orderStream(),
      keys.reservation(reservationId),
      userId,
      reservationId,
      saleId,
      RESERVATION_TTL_SEC,
    );

  let [outcome, id, remaining] = await run();

  if (outcome === 'NO_SALE') {
    // Cache miss (sale never primed, or Redis was flushed): load it from Mongo once.
    const sale = await FlashSale.findById(saleId).populate('product');
    if (!sale) throw notFound('Sale not found');
    await primeSale(sale);
    [outcome, id, remaining] = await run();
  }

  switch (outcome) {
    case 'OK':
      return { reservationId: id, status: 'QUEUED', duplicate: false, remaining: Number(remaining) };
    case 'DUPLICATE': {
      // Same user clicked again / retried: hand back the reservation they already hold.
      const existing = await getReservation(id, userId).catch(() => ({ status: 'QUEUED' }));
      return { reservationId: id, status: existing.status, duplicate: true };
    }
    case 'NOT_STARTED':
      throw conflict('SALE_NOT_STARTED', 'The sale has not started yet');
    case 'ENDED':
      throw conflict('SALE_ENDED', 'The sale has ended');
    case 'SOLD_OUT':
      throw conflict('SOLD_OUT', 'Sorry — this item is sold out');
    default:
      throw new AppError(500, 'INTERNAL_ERROR', 'Unexpected reservation outcome');
  }
}

/**
 * Status of a reservation, for the polling endpoint. Reads Redis first (fast);
 * if the Redis record has expired, falls back to the durable order in Mongo.
 * Reservations belonging to other users are reported as "not found" so ids
 * cannot be probed.
 */
export async function getReservation(reservationId, userId) {
  const r = await getRedis().hgetall(keys.reservation(reservationId));
  if (r.userId) {
    if (r.userId !== userId) throw notFound('Reservation not found');
    return {
      reservationId,
      saleId: r.saleId,
      status: r.status,
      orderId: r.orderId || undefined,
      reason: r.reason || undefined,
      createdAt: new Date(Number(r.createdAt)).toISOString(),
    };
  }
  const order = await Order.findOne({ reservationId }).lean();
  if (!order || order.user.toString() !== userId) throw notFound('Reservation not found');
  return {
    reservationId,
    saleId: order.sale.toString(),
    status: 'CONFIRMED',
    orderId: order._id.toString(),
    createdAt: order.createdAt.toISOString(),
  };
}

export async function listMyOrders(userId) {
  if (!isObjectId(userId)) return [];
  const orders = await Order.find({ user: userId })
    .populate('product', 'name imageUrl')
    .populate('sale', 'title')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return orders.map((o) => ({
    id: o._id.toString(),
    reservationId: o.reservationId,
    saleTitle: o.sale?.title,
    productName: o.product?.name,
    imageUrl: o.product?.imageUrl,
    priceCents: o.priceCents,
    status: o.status,
    createdAt: o.createdAt,
  }));
}
