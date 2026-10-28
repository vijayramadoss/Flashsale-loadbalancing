// Gateway webhooks. Outside the per-IP rate limiter (all webhooks come from the
// gateway's few addresses) but every request must carry a valid signature.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';
import { WebhookEvent } from '../models/WebhookEvent.js';
import { applyGatewayEvent } from '../services/paymentEvents.js';
import { AppError } from '../lib/errors.js';

const TOLERANCE_SEC = 300; // reject replays of old, captured webhook requests

/** Verifies "t=<unix>,v1=<hex hmac>" over "<t>.<raw body>" in constant time. */
export function verifySignature(rawBody, header, secret = config.payments.webhookSecret, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(now / 1000 - t) > TOLERANCE_SEC) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const given = Buffer.from(String(parts.v1));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export default async function webhookRoutes(app) {
  // The signature covers the exact bytes sent, so keep the raw body (this parser
  // is scoped to this plugin only).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { raw: body, json: JSON.parse(body) });
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  app.post('/webhooks/gateway', async (req) => {
    const { raw, json: event } = req.body || {};
    if (!raw || !verifySignature(raw, req.headers['gateway-signature'])) throw new AppError(401, 'BAD_SIGNATURE', 'Invalid webhook signature');
    if (!event?.id || !event?.type) throw new AppError(400, 'BAD_EVENT', 'Malformed event');

    // At-least-once delivery: a redelivered event is acknowledged without side effects.
    if (await WebhookEvent.exists({ eventId: event.id })) return { received: true, duplicate: true };
    // Apply first (all handlers are idempotent), then record — if applying fails we
    // answer 500 and the gateway retries, instead of marking a failed event as done.
    const result = await applyGatewayEvent(event);
    await WebhookEvent.create({ eventId: event.id, type: event.type, providerPaymentId: event.data?.providerPaymentId }).catch((err) => {
      if (err.code !== 11000) throw err;
    });
    return { received: true, result };
  });
}
