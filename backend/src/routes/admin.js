import { config } from '../config/env.js';
import { authenticate, requireAdmin } from '../plugins/guards.js';
import * as dealService from '../services/dealService.js';
import * as orderService from '../services/orderService.js';
import { idParams, money, sku } from '../schemas/common.js';
import { readTraffic } from '../plugins/traffic.js';
import * as couponService from '../services/couponService.js';
import * as adminCatalog from '../services/adminCatalogService.js';
import { objectId } from '../schemas/common.js';

export default async function adminRoutes(app) {
  // Applies to every route in this plugin (Fastify hooks are scoped to the plugin).
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/deals', async () => ({ deals: await dealService.listAllDeals() }));

  // Requests per second per API replica (written by plugins/traffic.js) — shows the load balancer at work.
  app.get('/traffic', {
    schema: { querystring: { type: 'object', properties: { seconds: { type: 'integer', minimum: 5, maximum: 170, default: 60 } } } },
    handler: async (req) => readTraffic(req.query.seconds),
  });

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
          waitingRoom: {
            type: 'object',
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' }, releasePerSec: { type: 'integer', minimum: 1, maximum: 100000 } },
          },
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
          status: { type: 'string', enum: ['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED', 'EXPIRED'] },
          returns: { type: 'boolean' },
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

  app.post('/orders/:id/return-decision', {
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['approve'], properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 300 } } },
    },
    handler: async (req) => ({ order: await orderService.decideReturn(req.params.id, req.body) }),
  });

  // ----- coupons -----
  app.get('/coupons', async () => ({ coupons: await couponService.listCoupons() }));
  app.post('/coupons', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'type', 'value', 'validFrom', 'validTo', 'usageLimit'],
        properties: {
          code: { type: 'string', pattern: '^[A-Za-z0-9]{3,20}$' },
          description: { type: 'string', maxLength: 140 },
          type: { type: 'string', enum: ['PERCENT', 'FLAT'] },
          value: { type: 'integer', minimum: 1 },
          maxDiscountCents: money,
          minOrderCents: money,
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time' },
          usageLimit: { type: 'integer', minimum: 1, maximum: 10_000_000 },
        },
      },
    },
    handler: async (req, reply) => {
      reply.code(201);
      return { coupon: await couponService.createCoupon({ ...req.body, code: req.body.code.toUpperCase(), validFrom: new Date(req.body.validFrom), validTo: new Date(req.body.validTo) }) };
    },
  });
  app.post('/coupons/:id/active', {
    schema: { params: idParams, body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } } },
    handler: async (req) => ({ coupon: await couponService.setCouponActive(req.params.id, req.body.active) }),
  });

  // ----- catalog -----
  const productParams = { type: 'object', properties: { id: objectId } };
  const variantParams = { type: 'object', properties: { id: objectId, sku } };
  app.get('/products', async () => ({ products: await adminCatalog.listProducts() }));
  app.patch('/products/:id', {
    schema: {
      params: productParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          tagline: { type: 'string', maxLength: 160 },
          description: { type: 'string', maxLength: 4000 },
          highlights: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
          active: { type: 'boolean' },
        },
      },
    },
    handler: async (req) => ({ product: await adminCatalog.updateProduct(req.params.id, req.body) }),
  });
  app.patch('/products/:id/variants/:sku', {
    schema: { params: variantParams, body: { type: 'object', additionalProperties: false, properties: { priceCents: money, mrpCents: money } } },
    handler: async (req) => ({ product: await adminCatalog.updateVariantPrice(req.params.id, req.params.sku, req.body) }),
  });
  app.post('/products/:id/variants/:sku/stock', {
    schema: { params: variantParams, body: { type: 'object', required: ['delta'], properties: { delta: { type: 'integer', minimum: -100_000, maximum: 100_000, not: { const: 0 } } } } },
    handler: async (req) => ({ product: await adminCatalog.adjustStock(req.params.id, req.params.sku, req.body.delta) }),
  });
  app.post('/products/:id/variants', {
    schema: {
      params: productParams,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['color', 'colorHex', 'storage', 'ram', 'priceCents', 'mrpCents', 'stock'],
        properties: {
          color: { type: 'string', minLength: 2, maxLength: 40 },
          colorHex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          storage: { type: 'string', pattern: '^[0-9]+ (GB|TB)$' },
          ram: { type: 'string', pattern: '^[0-9]+ GB$' },
          priceCents: money,
          mrpCents: money,
          stock: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        },
      },
    },
    handler: async (req, reply) => {
      reply.code(201);
      return { product: await adminCatalog.addVariant(req.params.id, req.body) };
    },
  });
}
