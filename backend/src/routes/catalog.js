import * as catalogService from '../services/catalogService.js';
import * as cartService from '../services/cartService.js';
import * as reviewService from '../services/reviewService.js';
import { authenticate, optionalAuth } from '../plugins/guards.js';
import { cartItems, deliveryMethod } from '../schemas/common.js';

export default async function catalogRoutes(app) {
  app.get('/products', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 60 },
          brand: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 },
          minPrice: { type: 'integer', minimum: 0 },
          maxPrice: { type: 'integer', minimum: 0 },
          sort: { type: 'string', enum: ['popular', 'price_asc', 'price_desc', 'newest', 'rating'] },
          inStock: { type: 'boolean' },
          page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 48, default: 12 },
        },
      },
    },
    handler: async (req, reply) => {
      // Shared caches (CDN/NGINX) may keep a listing briefly and refresh it in the background.
      reply.header('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
      return catalogService.listProducts(req.query);
    },
  });

  app.get('/products/:slug', {
    schema: { params: { type: 'object', properties: { slug: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' } } } },
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'public, max-age=5');
      return { product: await catalogService.getProduct(req.params.slug) };
    },
  });

  // Prices and availability for the browser-held cart (no account needed).
  app.post('/cart/quote', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: { items: { ...cartItems, minItems: 0 }, deliveryMethod, couponCode: { type: 'string', pattern: '^[A-Za-z0-9]{3,20}$' } },
      },
    },
    preHandler: optionalAuth, // signed-in shoppers also get "you already used this coupon" checks
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return cartService.quote(req.body.items, req.body.deliveryMethod, req.body.couponCode, req.user?.id);
    },
  });

  // ----- reviews -----
  const slugParams = { type: 'object', properties: { slug: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' } } };
  app.get('/products/:slug/reviews', {
    preHandler: optionalAuth,
    schema: { params: slugParams, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 } } } },
    handler: async (req) => reviewService.listReviews(req.params.slug, { page: req.query.page, userId: req.user?.id }),
  });
  app.post('/products/:slug/reviews', {
    preHandler: authenticate,
    schema: {
      params: slugParams,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['rating', 'title'],
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          title: { type: 'string', minLength: 3, maxLength: 100 },
          body: { type: 'string', maxLength: 2000 },
        },
      },
    },
    handler: async (req, reply) => {
      reply.code(201);
      return { review: await reviewService.addReview(req.params.slug, req.user.id, req.body) };
    },
  });
}
