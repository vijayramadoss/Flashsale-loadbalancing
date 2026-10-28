import { config } from '../config/env.js';
import { authenticate, botGuard, rateLimit } from '../plugins/guards.js';
import * as dealService from '../services/dealService.js';
import * as reservationService from '../services/reservationService.js';
import { idParams, looseIdParams } from '../schemas/common.js';

// Response schemas let Fastify serialise these hot responses with generated
// code (fast-json-stringify) instead of JSON.stringify.
const dealStatusSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    product: {
      type: 'object',
      properties: {
        slug: { type: 'string' }, brand: { type: 'string' }, name: { type: 'string' }, design: { type: 'string' },
        sku: { type: 'string' }, variantLabel: { type: 'string' }, colorHex: { type: 'string' },
      },
    },
    dealPriceCents: { type: 'integer' },
    mrpCents: { type: 'integer' },
    discountPct: { type: 'integer' },
    holdMinutes: { type: 'integer' },
    totalStock: { type: 'integer' },
    remainingStock: { type: 'integer' },
    startsAt: { type: 'string' },
    endsAt: { type: 'string' },
    state: { type: 'string' },
    serverTime: { type: 'string' },
  },
};

const reservationSchema = {
  type: 'object',
  properties: {
    reservationId: { type: 'string' },
    status: { type: 'string' },
    orderId: { type: 'string' },
    duplicate: { type: 'boolean' },
    remaining: { type: 'integer' },
    trackingUrl: { type: 'string' },
  },
};

export default async function dealRoutes(app) {
  const reserveUserLimiter = rateLimit({
    bucket: 'reserve-user',
    max: config.rateLimit.checkoutUserMax,
    windowSec: config.rateLimit.windowSec,
    keyFn: (req) => req.user.id,
  });

  app.get('/deals', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=2');
    return { deals: await dealService.listOpenDeals() };
  });

  app.get('/deals/:id', {
    schema: { params: looseIdParams, response: { 200: { type: 'object', properties: { deal: dealStatusSchema } } } },
    handler: async (req, reply) => {
      // 1-second shared cache: behind a CDN/NGINX, 100k pollers ≈ 1 origin request per second per edge.
      reply.header('Cache-Control', 'public, max-age=1');
      return { deal: await dealService.getDealStatus(req.params.id) };
    },
  });

  // THE HOT PATH: flash-deal "Buy now". One Lua call in Redis, no MongoDB.
  // 202 = a unit was reserved and a pending order is being created;
  // 200 = this customer's existing reservation (idempotent retry).
  app.post('/deals/:id/reserve', {
    preHandler: [botGuard, authenticate, reserveUserLimiter],
    schema: { params: idParams, response: { 200: reservationSchema, 202: reservationSchema } },
    handler: async (req, reply) => {
      const result = await reservationService.reserve(req.user.id, req.params.id);
      const trackingUrl = `/api/reservations/${result.reservationId}`;
      reply.header('Location', trackingUrl).header('Cache-Control', 'no-store');
      if (result.status === 'QUEUED') reply.header('Retry-After', '1');
      reply.code(result.duplicate ? 200 : 202);
      return { ...result, trackingUrl };
    },
  });

  // Polled by the client until RESERVED (→ go to checkout) or FAILED.
  app.get('/reservations/:id', {
    preHandler: authenticate,
    schema: { params: looseIdParams },
    handler: async (req, reply) => {
      const reservation = await reservationService.getReservation(req.params.id, req.user.id);
      reply.header('Cache-Control', 'no-store');
      if (reservation.status === 'QUEUED') reply.header('Retry-After', '1');
      return { reservation };
    },
  });
}
