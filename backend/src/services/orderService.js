// Order lifecycle:
//
//   (cart "Place order")  ─┐                      ┌─▶ CONFIRMED ─▶ SHIPPED ─▶ DELIVERED
//                          ├─▶ PENDING_PAYMENT ───┤
//   (deal reservation)    ─┘   (stock is held)    ├─▶ CANCELLED  (customer; stock returned, refund if paid)
//                                                  └─▶ EXPIRED    (hold ran out unpaid; stock returned)
//
// Every transition is a CONDITIONAL update on the current status, so racing
// requests (pay vs expiry, double pay, double cancel) resolve to exactly one winner.
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { ACTIVE_STATUSES, Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Deal } from '../models/Deal.js';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { resolveLines } from './cartService.js';
import { addressSnapshot } from './accountService.js';
import { deliveryQuote, priceOrder } from './pricing.js';
import { charge } from './paymentService.js';
import { isObjectId } from './dealService.js';

const PAID_STATUSES = ['CONFIRMED', 'SHIPPED', 'DELIVERED'];

export function newOrderNumber(now = new Date()) {
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const suffix = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `FS${ymd}-${suffix}`;
}

export function toOrderDto(o) {
  const now = Date.now();
  const pending = o.status === 'PENDING_PAYMENT' && o.expiresAt && o.expiresAt.getTime() > now;
  return {
    id: o._id.toString(),
    orderNumber: o.orderNumber,
    type: o.type,
    dealId: o.deal?.toString(),
    status: o.status,
    items: o.items.map((i) => ({
      slug: i.slug,
      sku: i.sku,
      brand: i.brand,
      name: i.name,
      variantLabel: i.variantLabel,
      colorHex: i.colorHex,
      design: i.design,
      qty: i.qty,
      unitPriceCents: i.unitPriceCents,
      mrpCents: i.mrpCents,
    })),
    pricing: o.pricing,
    shippingAddress: o.shippingAddress?.line1 ? o.shippingAddress : null,
    delivery: o.delivery,
    payment: {
      method: o.payment?.method,
      status: o.payment?.status,
      cardBrand: o.payment?.cardBrand,
      last4: o.payment?.last4,
      vpa: o.payment?.vpa,
      paidAt: o.payment?.paidAt,
      failedAttempts: o.payment?.failedAttempts || 0,
      lastError: o.payment?.lastError,
    },
    expiresAt: o.status === 'PENDING_PAYMENT' ? o.expiresAt : undefined,
    createdAt: o.createdAt,
    history: o.history,
    canPay: pending,
    canCancel: pending || o.status === 'CONFIRMED',
    codAllowed: o.type === 'CART',
  };
}

async function loadOwnOrder(orderId, userId) {
  if (!isObjectId(orderId)) throw notFound('Order not found');
  const order = await Order.findOne({ _id: orderId, user: userId });
  if (!order) throw notFound('Order not found');
  return order;
}

// ---------- create (cart) ----------

/**
 * Places a cart order: re-prices everything from the DB and, in ONE
 * transaction, decrements each variant's stock with a conditional update and
 * inserts the order. If any line can't be fulfilled the whole thing rolls back.
 */
export async function createCartOrder(userId, { items, addressId, deliveryMethod = 'STANDARD' }) {
  const shippingAddress = await addressSnapshot(userId, addressId);
  const lines = await resolveLines(items);
  const problems = lines.filter((l) => l.issue);
  if (problems.length) {
    throw conflict('CART_CHANGED', 'Some items in your cart changed — please review your cart', problems.map((l) => ({ sku: l.sku, issue: l.issue, maxQty: l.maxQty })));
  }

  const delivery = deliveryQuote(deliveryMethod);
  const pricing = priceOrder(lines, deliveryMethod);
  const session = await mongoose.startSession();
  let order;
  try {
    await session.withTransaction(async () => {
      for (const l of lines) {
        const res = await Product.updateOne(
          { _id: l.product, variants: { $elemMatch: { sku: l.sku, stock: { $gte: l.qty } } } },
          { $inc: { 'variants.$.stock': -l.qty } },
          { session },
        );
        if (res.modifiedCount !== 1) throw conflict('OUT_OF_STOCK', `${l.name} (${l.variantLabel}) just sold out`, [{ sku: l.sku, issue: 'OUT_OF_STOCK' }]);
      }
      [order] = await Order.create(
        [
          {
            orderNumber: newOrderNumber(),
            user: userId,
            type: 'CART',
            items: lines.map(({ product, slug, sku, brand, name, variantLabel, colorHex, design, qty, unitPriceCents, mrpCents }) => ({
              product, slug, sku, brand, name, variantLabel, colorHex, design, qty, unitPriceCents, mrpCents,
            })),
            pricing,
            shippingAddress,
            delivery: { method: delivery.method, etaFrom: delivery.etaFrom, etaTo: delivery.etaTo },
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(Date.now() + config.orders.cartHoldMinutes * 60_000),
            history: [{ status: 'PENDING_PAYMENT', note: 'Order placed — stock held while you pay' }],
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  return toOrderDto(order);
}

// ---------- read ----------

export async function getOrder(orderId, userId) {
  return toOrderDto(await loadOwnOrder(orderId, userId));
}

export async function listMyOrders(userId, { page = 1, limit = 10 } = {}) {
  const [orders, total] = await Promise.all([
    Order.find({ user: userId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Order.countDocuments({ user: userId }),
  ]);
  return { orders: orders.map(toOrderDto), page, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

// ---------- checkout details (deal orders start without an address) ----------

export async function setShipping(orderId, userId, { addressId, deliveryMethod = 'STANDARD' }) {
  const order = await loadOwnOrder(orderId, userId);
  if (order.status !== 'PENDING_PAYMENT' || order.expiresAt <= new Date()) throw conflict('ORDER_CLOSED', 'This order can no longer be changed');
  const shippingAddress = await addressSnapshot(userId, addressId);
  const delivery = deliveryQuote(deliveryMethod);
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PENDING_PAYMENT' },
    {
      $set: {
        shippingAddress,
        delivery: { method: delivery.method, etaFrom: delivery.etaFrom, etaTo: delivery.etaTo },
        pricing: priceOrder(order.items, deliveryMethod),
      },
    },
    { new: true },
  );
  if (!updated) throw conflict('ORDER_CLOSED', 'This order can no longer be changed');
  return toOrderDto(updated);
}

// ---------- pay ----------

/**
 * Pays a pending order through the (simulated) gateway.
 * Idempotency-Key: a retried request with the same key returns the original
 * result instead of charging twice.
 */
export async function payOrder(orderId, userId, { method, card, upi }, idempotencyKey) {
  const order = await loadOwnOrder(orderId, userId);

  if (PAID_STATUSES.includes(order.status)) {
    if (order.payment?.idempotencyKey === idempotencyKey) return toOrderDto(order); // replay
    throw conflict('ALREADY_PAID', 'This order is already paid');
  }
  if (order.status !== 'PENDING_PAYMENT') throw conflict('ORDER_CLOSED', `This order is ${order.status.toLowerCase()}`);
  if (order.expiresAt <= new Date()) throw conflict('ORDER_EXPIRED', 'The payment window for this order has expired');
  if (!order.shippingAddress?.line1) throw badRequest('Choose a delivery address first', [{ field: 'addressId', message: 'Required' }]);
  if (method === 'COD' && order.type === 'DEAL') throw badRequest('Flash-deal orders must be paid online', [{ field: 'method', message: 'Cash on delivery is not available for flash deals' }]);

  let payment;
  if (method === 'COD') {
    payment = { method: 'COD', status: 'COD', idempotencyKey };
  } else {
    const result = charge({ method, amountCents: order.pricing.totalCents, card, upi });
    if (!result.ok) {
      await Order.updateOne({ _id: order._id, status: 'PENDING_PAYMENT' }, { $inc: { 'payment.failedAttempts': 1 }, $set: { 'payment.lastError': result.message, 'payment.method': method } });
      throw new AppError(402, result.code, result.message);
    }
    payment = {
      method,
      status: 'PAID',
      transactionId: result.transactionId,
      cardBrand: result.cardBrand,
      last4: result.last4,
      vpa: result.vpa,
      paidAt: new Date(),
      idempotencyKey,
      failedAttempts: order.payment?.failedAttempts || 0,
    };
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PENDING_PAYMENT', expiresAt: { $gt: new Date() } },
    {
      $set: { status: 'CONFIRMED', payment },
      $push: { history: { status: 'CONFIRMED', note: method === 'COD' ? 'Confirmed — pay on delivery' : `Paid by ${method}` } },
    },
    { new: true },
  );
  if (updated) return toOrderDto(updated);

  // Lost a race: another request paid it, or the hold expired meanwhile.
  const fresh = await Order.findById(order._id);
  if (PAID_STATUSES.includes(fresh.status) && fresh.payment?.idempotencyKey === idempotencyKey) return toOrderDto(fresh);
  // A real gateway integration would refund/void the charge made above here.
  logger.warn('payment captured for a closed order — would refund', { orderId: String(order._id) });
  throw conflict(PAID_STATUSES.includes(fresh.status) ? 'ALREADY_PAID' : 'ORDER_EXPIRED', 'This order could not be paid (it was already paid or has expired)');
}

// ---------- release stock (cancel / expire) ----------

/**
 * Moves an order to CANCELLED/EXPIRED and gives its stock back — the status
 * change and the restock happen in one transaction. For deal orders the
 * Redis token and the customer's slot are released afterwards.
 * Returns the updated order, or null if another process already handled it.
 */
async function releaseOrder(filter, toStatus, note, extraSet = {}) {
  const session = await mongoose.startSession();
  let released = null;
  try {
    await session.withTransaction(async () => {
      released = await Order.findOneAndUpdate(
        filter,
        { $set: { status: toStatus, ...extraSet }, $unset: { activeDealKey: 1 }, $push: { history: { status: toStatus, note } } },
        { new: true, session },
      );
      if (!released) return;
      if (released.type === 'CART') {
        for (const i of released.items) {
          await Product.updateOne({ 'variants.sku': i.sku }, { $inc: { 'variants.$.stock': i.qty } }, { session });
        }
      } else {
        await Deal.updateOne({ _id: released.deal }, { $inc: { remainingStock: 1, soldCount: -1 } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }
  if (released?.type === 'DEAL') {
    // After the durable commit: put the token back on sale and let the customer try again.
    await getRedis()
      .fsRelease(keys.deal(released.deal), keys.buyers(released.deal), keys.reservation(released.reservationId), released.user.toString(), released.reservationId, toStatus, '1', '1')
      .catch((err) => logger.error('redis release failed (deal will under-sell until re-primed)', { orderId: String(released._id), err: err.message }));
  }
  return released;
}

export async function cancelOrder(orderId, userId) {
  const order = await loadOwnOrder(orderId, userId);
  if (!['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status)) throw conflict('CANNOT_CANCEL', 'This order can no longer be cancelled');
  const wasPaid = order.payment?.status === 'PAID';
  const released = await releaseOrder(
    { _id: order._id, status: { $in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
    'CANCELLED',
    wasPaid ? 'Cancelled by customer — refund issued' : 'Cancelled by customer',
    wasPaid ? { 'payment.status': 'REFUNDED' } : {},
  );
  if (!released) throw conflict('CANNOT_CANCEL', 'This order can no longer be cancelled');
  return toOrderDto(released);
}

/** Sweeper (run by the worker): releases stock held by unpaid orders whose hold expired. */
export async function expireDueOrders(limit = 100) {
  const due = await Order.find({ status: 'PENDING_PAYMENT', expiresAt: { $lte: new Date() } }, { _id: 1 }).limit(limit).lean();
  let expired = 0;
  for (const { _id } of due) {
    const released = await releaseOrder({ _id, status: 'PENDING_PAYMENT', expiresAt: { $lte: new Date() } }, 'EXPIRED', 'Payment not completed in time — stock released');
    if (released) expired++;
  }
  return expired;
}

// ---------- admin ----------

const NEXT_STATUS = { CONFIRMED: 'SHIPPED', SHIPPED: 'DELIVERED' };

export async function adminListOrders({ status, page = 1, limit = 20 } = {}) {
  const filter = status ? { status } : {};
  const [orders, total, byStatus] = await Promise.all([
    Order.find(filter).populate('user', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, revenue: { $sum: '$pricing.totalCents' } } }]),
  ]);
  return {
    orders: orders.map((o) => ({ ...toOrderDto(o), customer: o.user ? { name: o.user.name, email: o.user.email } : null })),
    page,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    summary: Object.fromEntries(byStatus.map((s) => [s._id, { count: s.n, revenueCents: s.revenue }])),
  };
}

export async function adminAdvanceStatus(orderId, to) {
  if (!isObjectId(orderId)) throw notFound('Order not found');
  const from = Object.keys(NEXT_STATUS).find((k) => NEXT_STATUS[k] === to);
  if (!from) throw badRequest('Invalid status transition');
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: from },
    { $set: { status: to }, $push: { history: { status: to, note: to === 'SHIPPED' ? 'Handed to courier' : 'Delivered' } } },
    { new: true },
  );
  if (!updated) throw conflict('INVALID_TRANSITION', `Order must be ${from} to mark it ${to}`);
  return toOrderDto(updated);
}

export { ACTIVE_STATUSES };
