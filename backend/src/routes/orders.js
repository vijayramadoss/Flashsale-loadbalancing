import { authenticate, botGuard } from '../plugins/guards.js';
import * as orderService from '../services/orderService.js';
import { cartItems, deliveryMethod, idParams, objectId } from '../schemas/common.js';

const shippingBody = {
  type: 'object',
  additionalProperties: false,
  required: ['addressId'],
  properties: { addressId: objectId, deliveryMethod },
};

const payBody = {
  type: 'object',
  additionalProperties: false,
  required: ['method'],
  properties: {
    method: { type: 'string', enum: ['UPI', 'CARD', 'COD'] },
    upi: { type: 'object', additionalProperties: false, properties: { vpa: { type: 'string', maxLength: 100 } } },
    card: {
      type: 'object',
      additionalProperties: false,
      properties: {
        number: { type: 'string', maxLength: 23 },
        expiry: { type: 'string', pattern: '^[0-9]{2}/[0-9]{2}$' },
        cvc: { type: 'string', maxLength: 4 },
        name: { type: 'string', maxLength: 80 },
      },
    },
  },
};

export default async function orderRoutes(app) {
  // Every order route is per-customer and must never be cached by a proxy.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // Place an order from the cart: stock is held for a few minutes while the customer pays.
  app.post('/orders', {
    preHandler: [botGuard, authenticate],
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['items', 'addressId'], properties: { items: cartItems, addressId: objectId, deliveryMethod } },
    },
    handler: async (req, reply) => {
      reply.code(201);
      return { order: await orderService.createCartOrder(req.user.id, req.body) };
    },
  });

  app.get('/orders', {
    preHandler: authenticate,
    schema: { querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 } } } },
    handler: async (req) => orderService.listMyOrders(req.user.id, { page: req.query.page }),
  });

  app.get('/orders/:id', { preHandler: authenticate, schema: { params: idParams } }, async (req) => ({
    order: await orderService.getOrder(req.params.id, req.user.id),
  }));

  // Address + delivery speed (deal orders are created before the customer picks these).
  app.put('/orders/:id/shipping', { preHandler: authenticate, schema: { params: idParams, body: shippingBody } }, async (req) => ({
    order: await orderService.setShipping(req.params.id, req.user.id, req.body),
  }));

  // Pay. The Idempotency-Key header makes a retried request (double click,
  // flaky network) return the first result instead of charging twice.
  app.post('/orders/:id/pay', {
    preHandler: [botGuard, authenticate],
    schema: {
      params: idParams,
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 80 } } },
      body: payBody,
    },
    handler: async (req) => ({ order: await orderService.payOrder(req.params.id, req.user.id, req.body, req.headers['idempotency-key']) }),
  });

  app.post('/orders/:id/cancel', { preHandler: authenticate, schema: { params: idParams } }, async (req) => ({
    order: await orderService.cancelOrder(req.params.id, req.user.id),
  }));
}
