// SIMULATED payment gateway that behaves like Razorpay/Stripe from the store's
// point of view — so the store's integration code is the real thing:
//
//  * createPayment() validates the instrument synchronously (bad card number,
//    expired card, malformed UPI id → immediate error, like a real gateway),
//    otherwise returns "processing" at once;
//  * the bank's decision arrives LATER as a signed webhook
//    (payment.captured / payment.failed) POSTed to our /api/webhooks/gateway;
//  * refunds are asynchronous too (refund.processed webhook);
//  * webhooks are retried with backoff until we answer 2xx (at-least-once);
//  * getPayment() lets our reconciliation job ask for the truth if a webhook was lost.
//
// State lives in Redis under "gw:" keys — a stand-in for the gateway's own database.
// Swapping in a real provider = implementing the same three functions.
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../../config/env.js';
import { getRedis, keys } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { charge } from '../paymentService.js';

export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Instrument problems a real gateway rejects before talking to the bank.
const SYNC_ERRORS = new Set(['INVALID_CARD', 'CARD_EXPIRED', 'INVALID_CVC', 'INVALID_VPA', 'UNSUPPORTED_METHOD']);
const RETRY_DELAYS_MS = [0, 1000, 3000, 10000, 30000];
const id = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

/** Signs a webhook the way the receiver verifies it: HMAC-SHA256 over "<timestamp>.<body>". */
export function signWebhook(body, timestamp = Math.floor(Date.now() / 1000), secret = config.payments.webhookSecret) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// How webhooks leave the "gateway": an HTTP POST by default; tests swap in app.inject().
let deliverer = async (body, headers) => {
  const res = await fetch(config.payments.webhookUrl, { method: 'POST', body, headers, signal: AbortSignal.timeout(5000) });
  return res.status;
};
export const setWebhookDeliverer = (fn) => {
  deliverer = fn;
};

async function emit(type, data) {
  const body = JSON.stringify({ id: id('evt'), type, created: Date.now(), data });
  for (const [attempt, wait] of RETRY_DELAYS_MS.entries()) {
    if (wait) await new Promise((r) => setTimeout(r, wait).unref?.());
    try {
      const status = await deliverer(body, { 'content-type': 'application/json', 'gateway-signature': signWebhook(body) });
      if (status >= 200 && status < 300) return;
      logger.warn('webhook rejected, will retry', { type, status, attempt });
    } catch (err) {
      logger.warn('webhook delivery failed, will retry', { type, attempt, err: err.message });
    }
  }
  logger.error('webhook delivery gave up — reconciliation will recover it', { type, data });
}

const later = (fn) => {
  const t = setTimeout(() => fn().catch((err) => logger.error('gateway task failed', { err: err.message })), config.payments.simDelayMs * (0.5 + Math.random()));
  t.unref?.();
};

export const simulatorGateway = {
  name: 'simulator',

  async createPayment({ amountCents, method, card, upi, metadata }) {
    const result = charge({ method, amountCents, card, upi });
    if (!result.ok && SYNC_ERRORS.has(result.code)) throw new GatewayError(result.code, result.message);
    const providerPaymentId = id('pay');
    const key = keys.gatewayPayment(providerPaymentId);
    const redis = getRedis();
    await redis.hset(key, 'status', 'processing', 'amountCents', String(amountCents), 'method', method, 'metadata', JSON.stringify(metadata || {}));
    await redis.expire(key, 7 * 24 * 3600);

    // The "bank" decides a moment later; the store learns the result via webhook.
    later(async () => {
      const final = result.ok
        ? { status: 'captured', cardBrand: result.cardBrand, last4: result.last4, vpa: result.vpa }
        : { status: 'failed', failureCode: result.code, failureMessage: result.message };
      await redis.hset(key, ...Object.entries(final).flatMap(([k, v]) => (v === undefined ? [] : [k, String(v)])));
      await emit(final.status === 'captured' ? 'payment.captured' : 'payment.failed', { providerPaymentId, amountCents, method, metadata, ...final });
    });
    return { providerPaymentId, status: 'processing' };
  },

  async refund(providerPaymentId, amountCents) {
    const redis = getRedis();
    const key = keys.gatewayPayment(providerPaymentId);
    const status = await redis.hget(key, 'status');
    if (status !== 'captured' && status !== 'refunded') throw new GatewayError('NOT_CAPTURED', 'Only captured payments can be refunded');
    const refundId = id('rfnd');
    later(async () => {
      await redis.hset(key, 'status', 'refunded', 'refundedCents', String(amountCents), 'refundId', refundId);
      await emit('refund.processed', { providerPaymentId, refundId, amountCents });
    });
    return { refundId };
  },

  /** The gateway's view of a payment (used by reconciliation when a webhook went missing). */
  async getPayment(providerPaymentId) {
    const h = await getRedis().hgetall(keys.gatewayPayment(providerPaymentId));
    if (!h.status) return null;
    return { providerPaymentId, ...h, amountCents: Number(h.amountCents), refundedCents: Number(h.refundedCents || 0) };
  },
};

export const gateway = simulatorGateway;
