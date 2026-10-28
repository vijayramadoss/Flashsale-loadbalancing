// Applies gateway outcomes (from webhooks OR from the reconciliation job) to
// our Payment and Order records. Every step is a conditional update on the
// current status, so applying the same outcome twice — a redelivered webhook,
// a webhook racing the reconciler — changes nothing the second time.
import { Payment } from '../models/Payment.js';
import { Order } from '../models/Order.js';
import { nextSequence } from '../models/Counter.js';
import { gateway } from './gateway/simulatorGateway.js';
import { logger } from '../lib/logger.js';

export async function assignInvoice(orderId) {
  const seq = await nextSequence('invoice');
  const number = `INV-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
  await Order.updateOne({ _id: orderId, 'invoice.number': { $exists: false } }, { $set: { invoice: { number, issuedAt: new Date() } } });
}

export async function onPaymentCaptured({ providerPaymentId, cardBrand, last4, vpa }) {
  const payment = await Payment.findOneAndUpdate(
    { providerPaymentId, status: 'PROCESSING' },
    { $set: { status: 'CAPTURED', capturedAt: new Date(), cardBrand, last4, vpa } },
    { new: true },
  );
  if (!payment) return 'ignored'; // already applied (or unknown)

  const order = await Order.findOneAndUpdate(
    // Money arrived while we still hold the stock → confirm, even if the hold timer ran out
    // a moment ago (the sweeper skips orders with a payment in flight).
    { _id: payment.order, status: 'PENDING_PAYMENT' },
    {
      $set: {
        status: 'CONFIRMED',
        'payment.status': 'PAID',
        'payment.method': payment.method,
        'payment.paymentId': payment._id,
        'payment.transactionId': providerPaymentId,
        'payment.cardBrand': cardBrand,
        'payment.last4': last4,
        'payment.vpa': vpa,
        'payment.paidAt': new Date(),
        'payment.idempotencyKey': payment.idempotencyKey,
      },
      $unset: { expiresAt: 1 },
      $push: { history: { status: 'CONFIRMED', note: `Paid by ${payment.method} (${providerPaymentId})` } },
    },
    { new: true },
  );
  if (order) {
    await assignInvoice(order._id);
    return 'confirmed';
  }
  // The order was cancelled/expired before the money arrived → give it back automatically.
  await gateway.refund(providerPaymentId, payment.amountCents);
  await Payment.updateOne({ _id: payment._id, status: 'CAPTURED' }, { $set: { status: 'REFUND_PENDING' } });
  await Order.updateOne(
    { _id: payment.order },
    { $push: { history: { status: 'REFUND', note: 'Payment arrived after the order closed — refund started automatically' } } },
  );
  logger.warn('late capture refunded', { providerPaymentId, orderId: String(payment.order) });
  return 'refunded-late';
}

export async function onPaymentFailed({ providerPaymentId, paymentId, failureCode, failureMessage }) {
  const payment = await Payment.findOneAndUpdate(
    providerPaymentId ? { providerPaymentId, status: 'PROCESSING' } : { _id: paymentId, status: 'PROCESSING' },
    { $set: { status: 'FAILED', failureCode, failureMessage } },
    { new: true },
  );
  if (!payment) return 'ignored';
  // The order stays payable: the customer can try another method while the hold lasts.
  await Order.updateOne(
    { _id: payment.order, status: 'PENDING_PAYMENT', 'payment.paymentId': payment._id },
    { $set: { 'payment.status': 'PENDING', 'payment.lastError': failureMessage }, $inc: { 'payment.failedAttempts': 1 } },
  );
  return 'failed';
}

export async function onRefundProcessed({ providerPaymentId, amountCents }) {
  const payment = await Payment.findOneAndUpdate(
    { providerPaymentId, status: { $in: ['CAPTURED', 'REFUND_PENDING'] } },
    { $set: { status: 'REFUNDED', refundedCents: amountCents, refundedAt: new Date() } },
    { new: true },
  );
  if (!payment) return 'ignored';
  await Order.updateOne(
    { _id: payment.order, 'payment.paymentId': payment._id },
    { $set: { 'payment.status': 'REFUNDED' }, $push: { history: { status: 'REFUND', note: 'Refund completed to the original payment method' } } },
  );
  return 'refunded';
}

/** Routes a verified webhook event to the right handler. */
export async function applyGatewayEvent(event) {
  switch (event.type) {
    case 'payment.captured':
      return onPaymentCaptured(event.data);
    case 'payment.failed':
      return onPaymentFailed(event.data);
    case 'refund.processed':
      return onRefundProcessed(event.data);
    default:
      return 'unhandled';
  }
}

/**
 * Reconciliation (run by the worker): payments still PROCESSING / REFUND_PENDING
 * after a while probably missed their webhook — ask the gateway for the truth.
 */
export async function reconcilePayments(olderThanMs) {
  const stale = await Payment.find(
    { status: { $in: ['PROCESSING', 'REFUND_PENDING'] }, updatedAt: { $lte: new Date(Date.now() - olderThanMs) } },
    { _id: 1, providerPaymentId: 1, status: 1, amountCents: 1 },
  ).limit(100).lean();
  let fixed = 0;
  for (const p of stale) {
    const g = p.providerPaymentId ? await gateway.getPayment(p.providerPaymentId) : null;
    let result = 'ignored';
    if (!g) {
      // The gateway never heard of it (crash between our insert and the gateway call).
      result = await onPaymentFailed({ providerPaymentId: p.providerPaymentId, paymentId: p._id, failureCode: 'LOST', failureMessage: 'Payment could not be completed' });
    } else if (p.status === 'PROCESSING' && g.status === 'captured') result = await onPaymentCaptured(g);
    else if (p.status === 'PROCESSING' && g.status === 'failed') result = await onPaymentFailed(g);
    else if (g.status === 'refunded') result = await onRefundProcessed({ providerPaymentId: p.providerPaymentId, amountCents: g.refundedCents });
    if (result !== 'ignored') fixed++;
  }
  return fixed;
}
