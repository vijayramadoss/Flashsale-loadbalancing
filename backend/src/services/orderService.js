// Order lifecycle:
//
//   (cart "Place order")  ─┐                      ┌─▶ CONFIRMED ─▶ SHIPPED ─▶ DELIVERED ─(return approved)─▶ RETURNED
//                          ├─▶ PENDING_PAYMENT ───┤
//   (deal reservation)    ─┘   (stock is held)    ├─▶ CANCELLED  (customer; stock returned, refund if paid)
//                                                  └─▶ EXPIRED    (hold ran out unpaid; stock returned)
//
// Payment goes through the gateway asynchronously: "Pay" creates a payment and
// returns 202; the gateway's webhook (services/paymentEvents.js) confirms the order.
// Every transition is a CONDITIONAL update on the current status, so racing
// requests (webhook vs expiry, double pay, double cancel) resolve to exactly one winner.
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { ACTIVE_STATUSES, Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Deal } from '../models/Deal.js';
import { Payment } from '../models/Payment.js';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { resolveLines } from './cartService.js';
import { addressSnapshot } from './accountService.js';
import { deliveryQuote, gstBreakup, priceOrder } from './pricing.js';
import { isObjectId } from './dealService.js';
import { redeemCoupon, releaseCoupon } from './couponService.js';
import { gateway, GatewayError } from './gateway/simulatorGateway.js';
import { assignInvoice } from './paymentEvents.js';

const PAID_STATUSES = ['CONFIRMED', 'SHIPPED', 'DELIVERED'];
const DAY = 24 * 60 * 60 * 1000;

export function newOrderNumber(now = new Date()) {
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const suffix = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `FS${ymd}-${suffix}`;
}

export function toOrderDto(o) {
  const now = Date.now();
  const pending = o.status === 'PENDING_PAYMENT' && o.expiresAt && o.expiresAt.getTime() > now;
  const returnOpen = o.status === 'DELIVERED' && o.deliveredAt && now - o.deliveredAt.getTime() < config.returnWindowDays * DAY;
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
    coupon: o.coupon?.code ? { code: o.coupon.code } : null,
    shippingAddress: o.shippingAddress?.line1 ? o.shippingAddress : null,
    delivery: o.delivery,
    payment: {
      method: o.payment?.method,
      status: o.payment?.status,
      paymentId: o.payment?.paymentId?.toString(),
      cardBrand: o.payment?.cardBrand,
      last4: o.payment?.last4,
      vpa: o.payment?.vpa,
      paidAt: o.payment?.paidAt,
      failedAttempts: o.payment?.failedAttempts || 0,
      lastError: o.payment?.lastError,
    },
    invoice: o.invoice?.number ? o.invoice : null,
    returnRequest: o.returnRequest?.status ? o.returnRequest : null,
    expiresAt: o.status === 'PENDING_PAYMENT' ? o.expiresAt : undefined,
    deliveredAt: o.deliveredAt,
    createdAt: o.createdAt,
    history: o.history,
    canPay: pending && o.payment?.status !== 'PROCESSING',
    canCancel: (pending && o.payment?.status !== 'PROCESSING') || o.status === 'CONFIRMED',
    canReturn: Boolean(returnOpen && !o.returnRequest?.status),
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
 * transaction, decrements each variant's stock with a conditional update,
 * redeems the coupon (atomic usage counter + one-per-customer row) and inserts
 * the order. If anything fails, the whole thing rolls back.
 */
export async function createCartOrder(userId, { items, addressId, deliveryMethod = 'STANDARD', couponCode }) {
  const shippingAddress = await addressSnapshot(userId, addressId);
  const lines = await resolveLines(items);
  const problems = lines.filter((l) => l.issue);
  if (problems.length) {
    throw conflict('CART_CHANGED', 'Some items in your cart changed — please review your cart', problems.map((l) => ({ sku: l.sku, issue: l.issue, maxQty: l.maxQty })));
  }

  const delivery = deliveryQuote(deliveryMethod);
  const orderId = new mongoose.Types.ObjectId();
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
      const subtotalCents = lines.reduce((n, l) => n + l.unitPriceCents * l.qty, 0);
      const coupon = couponCode ? await redeemCoupon({ code: couponCode, userId, orderId, subtotalCents }, session) : null;
      [order] = await Order.create(
        [
          {
            _id: orderId,
            orderNumber: newOrderNumber(),
            user: userId,
            type: 'CART',
            items: lines.map(({ product, slug, sku, brand, name, variantLabel, colorHex, design, qty, unitPriceCents, mrpCents }) => ({
              product, slug, sku, brand, name, variantLabel, colorHex, design, qty, unitPriceCents, mrpCents,
            })),
            pricing: priceOrder(lines, deliveryMethod, coupon?.discountCents || 0),
            coupon: coupon ? { id: coupon.id, code: coupon.code } : undefined,
            shippingAddress,
            delivery: { method: delivery.method, etaFrom: delivery.etaFrom, etaTo: delivery.etaTo },
            status: 'PENDING_PAYMENT',
            expiresAt: new Date(Date.now() + config.orders.cartHoldMinutes * 60_000),
            history: [{ status: 'PENDING_PAYMENT', note: `Order placed — stock held while you pay${coupon ? ` (coupon ${coupon.code})` : ''}` }],
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

/** Data for the printable tax invoice (only for confirmed-or-later orders). */
export async function getInvoice(orderId, userId) {
  const order = await loadOwnOrder(orderId, userId);
  if (!order.invoice?.number) throw conflict('NO_INVOICE', 'An invoice is issued once the order is confirmed');
  return {
    invoiceNumber: order.invoice.number,
    issuedAt: order.invoice.issuedAt,
    orderNumber: order.orderNumber,
    orderDate: order.createdAt,
    seller: { name: 'FlashSale Retail (demo)', address: 'Demo address — not a real business', gstin: '00DEMO0000D0Z0' },
    billTo: order.shippingAddress,
    items: toOrderDto(order).items,
    pricing: order.pricing,
    tax: gstBreakup(order.pricing.totalCents),
    payment: toOrderDto(order).payment,
    status: order.status,
  };
}

// ---------- checkout details (deal orders start without an address) ----------

export async function setShipping(orderId, userId, { addressId, deliveryMethod = 'STANDARD' }) {
  const order = await loadOwnOrder(orderId, userId);
  if (order.status !== 'PENDING_PAYMENT' || order.expiresAt <= new Date()) throw conflict('ORDER_CLOSED', 'This order can no longer be changed');
  if (order.payment?.status === 'PROCESSING') throw conflict('PAYMENT_IN_PROGRESS', 'A payment is already being processed');
  const shippingAddress = await addressSnapshot(userId, addressId);
  const delivery = deliveryQuote(deliveryMethod);
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PENDING_PAYMENT' },
    {
      $set: {
        shippingAddress,
        delivery: { method: delivery.method, etaFrom: delivery.etaFrom, etaTo: delivery.etaTo },
        pricing: priceOrder(order.items, deliveryMethod, order.pricing.couponDiscountCents || 0),
      },
    },
    { new: true },
  );
  if (!updated) throw conflict('ORDER_CLOSED', 'This order can no longer be changed');
  return toOrderDto(updated);
}

// ---------- pay ----------

export function toPaymentDto(p) {
  return {
    id: p._id.toString(),
    orderId: p.order.toString(),
    method: p.method,
    amountCents: p.amountCents,
    status: p.status,
    failureCode: p.failureCode,
    failureMessage: p.failureMessage,
    cardBrand: p.cardBrand,
    last4: p.last4,
    vpa: p.vpa,
  };
}

/**
 * Starts paying a pending order.
 *  * COD → confirmed immediately (no gateway).
 *  * UPI / card → creates a Payment and hands it to the gateway; returns
 *    { status: 'PROCESSING' } at once. The gateway's webhook later confirms the
 *    order (or reports a decline). The client polls GET /api/payments/:id.
 * Idempotency-Key: a retried request with the same key returns the same payment.
 */
export async function payOrder(orderId, userId, { method, card, upi }, idempotencyKey) {
  const order = await loadOwnOrder(orderId, userId);

  if (PAID_STATUSES.includes(order.status)) {
    if (order.payment?.idempotencyKey === idempotencyKey) {
      const p = order.payment?.paymentId ? await Payment.findById(order.payment.paymentId) : null;
      return { order: toOrderDto(order), payment: p ? toPaymentDto(p) : null };
    }
    throw conflict('ALREADY_PAID', 'This order is already paid');
  }
  const replay = await Payment.findOne({ order: order._id, idempotencyKey });
  if (replay) return { order: toOrderDto(order), payment: toPaymentDto(replay) };

  if (order.status !== 'PENDING_PAYMENT') throw conflict('ORDER_CLOSED', `This order is ${order.status.toLowerCase()}`);
  if (order.expiresAt <= new Date()) throw conflict('ORDER_EXPIRED', 'The payment window for this order has expired');
  if (!order.shippingAddress?.line1) throw badRequest('Choose a delivery address first', [{ field: 'addressId', message: 'Required' }]);
  if (method === 'COD' && order.type === 'DEAL') throw badRequest('Flash-deal orders must be paid online', [{ field: 'method', message: 'Cash on delivery is not available for flash deals' }]);
  if (order.payment?.status === 'PROCESSING') throw conflict('PAYMENT_IN_PROGRESS', 'A payment for this order is already being processed');

  if (method === 'COD') {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING_PAYMENT', expiresAt: { $gt: new Date() } },
      {
        $set: { status: 'CONFIRMED', payment: { method: 'COD', status: 'COD', idempotencyKey, failedAttempts: order.payment?.failedAttempts || 0 } },
        $unset: { expiresAt: 1 },
        $push: { history: { status: 'CONFIRMED', note: 'Confirmed — pay on delivery' } },
      },
      { new: true },
    );
    if (!updated) throw conflict('ORDER_EXPIRED', 'This order could not be confirmed (it was already paid or has expired)');
    await assignInvoice(updated._id);
    return { order: toOrderDto(await Order.findById(updated._id)), payment: null };
  }

  // Claim the order for this payment attempt first (only one attempt may be in flight).
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, status: 'PENDING_PAYMENT', expiresAt: { $gt: new Date() }, 'payment.status': { $ne: 'PROCESSING' } },
    {
      $set: { 'payment.status': 'PROCESSING', 'payment.method': method },
      // Don't let the hold run out while the bank is deciding.
      $max: { expiresAt: new Date(Date.now() + 2 * 60_000) },
    },
    { new: true },
  );
  if (!claimed) throw conflict('PAYMENT_IN_PROGRESS', 'This order cannot be paid right now — refresh and try again');

  let payment;
  try {
    payment = await Payment.create({ order: order._id, user: userId, method, amountCents: order.pricing.totalCents, idempotencyKey, status: 'PROCESSING' });
  } catch (err) {
    await Order.updateOne({ _id: order._id, 'payment.status': 'PROCESSING' }, { $set: { 'payment.status': 'PENDING' } });
    if (err.code === 11000) {
      const p = await Payment.findOne({ order: order._id, idempotencyKey });
      return { order: toOrderDto(order), payment: toPaymentDto(p) };
    }
    throw err;
  }
  await Order.updateOne({ _id: order._id }, { $set: { 'payment.paymentId': payment._id } });

  try {
    const { providerPaymentId } = await gateway.createPayment({
      amountCents: payment.amountCents,
      method,
      card,
      upi,
      metadata: { orderId: String(order._id), paymentId: String(payment._id) },
    });
    payment.providerPaymentId = providerPaymentId;
    await payment.save();
  } catch (err) {
    // Synchronous rejection (bad card number, expired card, malformed UPI id).
    const code = err instanceof GatewayError ? err.code : 'GATEWAY_ERROR';
    const message = err instanceof GatewayError ? err.message : 'The payment gateway is unavailable — please try again';
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'FAILED', failureCode: code, failureMessage: message } });
    await Order.updateOne(
      { _id: order._id, 'payment.paymentId': payment._id },
      { $set: { 'payment.status': 'PENDING', 'payment.lastError': message }, $inc: { 'payment.failedAttempts': 1 } },
    );
    throw new AppError(err instanceof GatewayError ? 402 : 503, code, message);
  }
  return { order: toOrderDto(await Order.findById(order._id)), payment: toPaymentDto(payment) };
}

export async function getPayment(paymentId, userId) {
  if (!isObjectId(paymentId)) throw notFound('Payment not found');
  const p = await Payment.findOne({ _id: paymentId, user: userId });
  if (!p) throw notFound('Payment not found');
  return toPaymentDto(p);
}

/** Starts a gateway refund for an order's captured payment (async; the webhook completes it). */
async function refundPayment(order, reasonNote) {
  if (!order.payment?.paymentId || order.payment.status !== 'PAID') return false;
  const p = await Payment.findOneAndUpdate({ _id: order.payment.paymentId, status: 'CAPTURED' }, { $set: { status: 'REFUND_PENDING' } }, { new: true });
  if (!p) return false;
  await gateway.refund(p.providerPaymentId, p.amountCents);
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'payment.status': 'REFUND_PENDING' }, $push: { history: { status: 'REFUND', note: reasonNote } } },
  );
  return true;
}

// ---------- release stock (cancel / expire) ----------

/**
 * Moves an order to CANCELLED/EXPIRED and gives its stock (and coupon use) back —
 * the status change and the restock happen in one transaction. For deal orders
 * the Redis token and the customer's slot are released afterwards.
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
      await releaseCoupon(released, session);
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
  if (order.payment?.status === 'PROCESSING') throw conflict('PAYMENT_IN_PROGRESS', 'Wait for the payment to finish before cancelling');
  const released = await releaseOrder(
    { _id: order._id, status: { $in: ['PENDING_PAYMENT', 'CONFIRMED'] }, 'payment.status': { $ne: 'PROCESSING' } },
    'CANCELLED',
    'Cancelled by customer',
  );
  if (!released) throw conflict('CANNOT_CANCEL', 'This order can no longer be cancelled');
  await refundPayment(released, 'Refund started to the original payment method');
  return toOrderDto(await Order.findById(released._id));
}

/** Sweeper (run by the worker): releases stock held by unpaid orders whose hold expired. */
export async function expireDueOrders(limit = 100) {
  // Orders with a payment in flight are skipped — the gateway result (or reconciliation) decides them.
  const filter = { status: 'PENDING_PAYMENT', expiresAt: { $lte: new Date() }, 'payment.status': { $ne: 'PROCESSING' } };
  const due = await Order.find(filter, { _id: 1 }).limit(limit).lean();
  let expired = 0;
  for (const { _id } of due) {
    const released = await releaseOrder({ ...filter, _id, expiresAt: { $lte: new Date() } }, 'EXPIRED', 'Payment not completed in time — stock released');
    if (released) expired++;
  }
  return expired;
}

// ---------- returns ----------

export async function requestReturn(orderId, userId, { reason }) {
  const order = await loadOwnOrder(orderId, userId);
  if (!toOrderDto(order).canReturn) {
    throw conflict('RETURN_NOT_ALLOWED', order.returnRequest?.status ? 'A return was already requested for this order' : `Returns are possible within ${config.returnWindowDays} days of delivery`);
  }
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: 'DELIVERED', 'returnRequest.status': { $exists: false } },
    { $set: { returnRequest: { status: 'REQUESTED', reason, requestedAt: new Date() } }, $push: { history: { status: 'RETURN', note: `Return requested: ${reason}` } } },
    { new: true },
  );
  if (!updated) throw conflict('RETURN_NOT_ALLOWED', 'A return was already requested for this order');
  return toOrderDto(updated);
}

/** Admin decision. Approving restocks the items (to regular stock) and refunds the customer. */
export async function decideReturn(orderId, { approve, note = '' }) {
  if (!isObjectId(orderId)) throw notFound('Order not found');
  if (!approve) {
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, status: 'DELIVERED', 'returnRequest.status': 'REQUESTED' },
      { $set: { 'returnRequest.status': 'REJECTED', 'returnRequest.decidedAt': new Date(), 'returnRequest.note': note }, $push: { history: { status: 'RETURN', note: `Return rejected${note ? `: ${note}` : ''}` } } },
      { new: true },
    );
    if (!updated) throw conflict('INVALID_TRANSITION', 'No pending return request on this order');
    return toOrderDto(updated);
  }
  const session = await mongoose.startSession();
  let returned;
  try {
    await session.withTransaction(async () => {
      returned = await Order.findOneAndUpdate(
        { _id: orderId, status: 'DELIVERED', 'returnRequest.status': 'REQUESTED' },
        {
          $set: { status: 'RETURNED', 'returnRequest.status': 'APPROVED', 'returnRequest.decidedAt': new Date(), 'returnRequest.note': note },
          $push: { history: { status: 'RETURNED', note: 'Return approved — item received back' } },
        },
        { new: true, session },
      );
      if (!returned) return;
      // Returned units go back into regular stock (a deal's allocation is not reopened).
      for (const i of returned.items) await Product.updateOne({ 'variants.sku': i.sku }, { $inc: { 'variants.$.stock': i.qty } }, { session });
    });
  } finally {
    await session.endSession();
  }
  if (!returned) throw conflict('INVALID_TRANSITION', 'No pending return request on this order');
  if (returned.payment?.status === 'COD') {
    await Order.updateOne({ _id: returned._id }, { $set: { 'payment.status': 'REFUNDED' }, $push: { history: { status: 'REFUND', note: 'Refund sent to your bank account' } } });
  } else {
    await refundPayment(returned, 'Refund started for the returned item');
  }
  return toOrderDto(await Order.findById(returned._id));
}

// ---------- admin ----------

const NEXT_STATUS = { CONFIRMED: 'SHIPPED', SHIPPED: 'DELIVERED' };

export async function adminListOrders({ status, returns, page = 1, limit = 20 } = {}) {
  const filter = returns ? { 'returnRequest.status': 'REQUESTED' } : status ? { status } : {};
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
    {
      $set: { status: to, ...(to === 'DELIVERED' ? { deliveredAt: new Date() } : {}) },
      $push: { history: { status: to, note: to === 'SHIPPED' ? 'Handed to courier' : 'Delivered' } },
    },
    { new: true },
  );
  if (!updated) throw conflict('INVALID_TRANSITION', `Order must be ${from} to mark it ${to}`);
  return toOrderDto(updated);
}

export { ACTIVE_STATUSES };
