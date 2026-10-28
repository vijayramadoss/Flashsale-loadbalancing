import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { getRedis } from '../lib/redis.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { botGuard } from '../middleware/botGuard.js';
import * as auth from '../controllers/authController.js';
import * as sales from '../controllers/saleController.js';
import * as checkout from '../controllers/checkoutController.js';
import { checkoutSchema, createSaleSchema, idParamSchema, loginSchema, registerSchema, resetSaleSchema } from './schemas.js';

const { windowSec } = config.rateLimit;
const authLimiter = rateLimit({ bucket: 'auth-ip', max: config.rateLimit.authIpMax, windowSec });
const checkoutUserLimiter = rateLimit({
  bucket: 'checkout-user',
  max: config.rateLimit.checkoutUserMax,
  windowSec,
  keyFn: (req) => req.user.id,
});

export function buildApiRouter() {
  const api = Router();

  // ----- health (not rate limited: load balancers poll these) -----
  api.get('/health', (_req, res) => res.json({ status: 'ok', pid: process.pid }));
  api.get('/health/ready', async (_req, res) => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = await getRedis().ping().then((r) => r === 'PONG').catch(() => false);
    res.status(mongoOk && redisOk ? 200 : 503).json({ mongo: mongoOk, redis: redisOk });
  });

  // Every other API route shares a per-IP budget across all replicas.
  api.use(rateLimit({ bucket: 'ip', max: config.rateLimit.ipMax, windowSec }));

  // ----- auth -----
  api.post('/auth/register', authLimiter, botGuard, validate(registerSchema), auth.register);
  api.post('/auth/login', authLimiter, botGuard, validate(loginSchema), auth.login);
  api.get('/auth/me', requireAuth, auth.me);

  // ----- public sale info -----
  api.get('/sales', sales.list);
  api.get('/sales/:id', validate(idParamSchema, 'params'), sales.status);

  // ----- checkout (the hot path) -----
  api.post('/checkout', botGuard, requireAuth, checkoutUserLimiter, validate(checkoutSchema), checkout.checkout);
  api.get('/checkout/:id', requireAuth, validate(idParamSchema, 'params'), checkout.trackReservation);
  api.get('/orders/mine', requireAuth, checkout.myOrders);

  // ----- admin -----
  const admin = Router();
  admin.use(requireAuth, requireRole('admin'));
  admin.get('/sales', sales.adminList);
  admin.post('/sales', validate(createSaleSchema), sales.adminCreate);
  admin.get('/sales/:id/stats', validate(idParamSchema, 'params'), sales.adminStats);
  admin.post('/sales/:id/reset', validate(idParamSchema, 'params'), validate(resetSaleSchema), sales.adminReset);
  api.use('/admin', admin);

  return api;
}
