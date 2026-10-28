import { config } from '../config/env.js';
import { authenticate, requireAdmin } from '../plugins/guards.js';
import * as dealService from '../services/dealService.js';
import * as orderService from '../services/orderService.js';
import { idParams, money, sku } from '../schemas/common.js';

export default async function adminRoutes(app) {
  // Applies to every route in this plugin (Fastify hooks are scoped to the plugin).
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/deals', async () => ({ deals: await dealService.listAllDeals() }));

  app.post('/deals', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'title', 'dealPriceCents', 'totalStock', 'startsAt', 'endsAt'],
        properties: {
          sku,
          title: { type: 'string', minLength: 2, maxLength: 120 },
          dealPriceCents: money,
          totalStock: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          holdMinutes: { type: 'integer', minimum: 1, maximum: 60 },
        },
      },
    },
    handler: async (req, reply) => {
      const body = { ...req.body, startsAt: new Date(req.body.startsAt), endsAt: new Date(req.body.endsAt) };
      if (body.endsAt <= body.startsAt) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: [{ field: 'endsAt', message: 'must be after startsAt' }] } });
      }
      const deal = await dealService.createDeal(body);
      reply.code(201);
      return { deal: await dealService.getDealStats(deal._id.toString()) };
    },
  });

  app.get('/deals/:id/stats', { schema: { params: idParams } }, async (req) => ({ stats: await dealService.getDealStats(req.params.id) }));

  app.post('/deals/:id/reset', {
    schema: {
      params: idParams,
      body: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: { startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' } },
      },
    },
    handler: async (req) => {
      const b = req.body || {};
      const times = { startsAt: b.startsAt && new Date(b.startsAt), endsAt: b.endsAt && new Date(b.endsAt) };
      return { stats: await dealService.resetDeal(req.params.id, times, { isProduction: config.isProduction }) };
    },
  });

  app.get('/orders', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED'] },
          page: { type: 'integer', minimum: 1, default: 1 },
        },
      },
    },
    handler: async (req) => orderService.adminListOrders(req.query),
  });

  app.post('/orders/:id/status', {
    schema: { params: idParams, body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['SHIPPED', 'DELIVERED'] } } } },
    handler: async (req) => ({ order: await orderService.adminAdvanceStatus(req.params.id, req.body.status) }),
  });
}
