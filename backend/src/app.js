import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { getRedis } from './lib/redis.js';
import { notFound } from './lib/errors.js';
import { errorHandler } from './plugins/errors.js';
import { rateLimit } from './plugins/guards.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import dealRoutes from './routes/deals.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';

const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');

/** Builds the Fastify app without listening, so tests can use app.inject(). */
export async function buildApp() {
  const app = Fastify({
    // Behind NGINX/ALB, request.ip comes from X-Forwarded-For — but only when
    // the request arrives from one of the configured proxy addresses.
    trustProxy: config.trustProxy || false,
    bodyLimit: 16 * 1024,
    keepAliveTimeout: 65_000, // > load balancer idle timeout → no sporadic 502s
    // pino at "warn": errors are logged, per-request info logs on the hot path are not.
    logger: config.isTest ? false : { level: 'warn' },
    ajv: { customOptions: { allErrors: true, removeAdditional: false } },
  });

  await app.register(helmet, { crossOriginEmbedderPolicy: false });
  await app.register(compress, { threshold: 1024, global: true });
  app.setErrorHandler(errorHandler);

  await app.register(
    async (api) => {
      // Health checks are outside the rate limit (load balancers poll them).
      api.get('/health', async () => ({ status: 'ok', pid: process.pid }));
      api.get('/health/ready', async (_req, reply) => {
        const mongoOk = mongoose.connection.readyState === 1;
        const redisOk = await getRedis().ping().then((r) => r === 'PONG').catch(() => false);
        reply.code(mongoOk && redisOk ? 200 : 503);
        return { mongo: mongoOk, redis: redisOk };
      });

      await api.register(async (limited) => {
        // Every other API route shares a per-IP budget, enforced across all replicas.
        limited.addHook('preHandler', rateLimit({ bucket: 'ip', max: config.rateLimit.ipMax, windowSec: config.rateLimit.windowSec }));
        await limited.register(authRoutes);
        await limited.register(catalogRoutes);
        await limited.register(dealRoutes);
        await limited.register(orderRoutes);
        await limited.register(adminRoutes, { prefix: '/admin' });
      });
    },
    { prefix: '/api' },
  );

  const serveSpa = config.serveFrontend && fs.existsSync(frontendDist);
  if (serveSpa) {
    // Vite emits content-hashed file names → safe to cache for a year (a CDN would serve these in production).
    await app.register(fastifyStatic, {
      root: frontendDist,
      index: false,
      wildcard: false,
      // Serve the .br / .gz files written at build time (max-quality Brotli, no per-request CPU).
      preCompressed: true,
      // @fastify/static passes the Fastify reply here.
      setHeaders: (reply, filePath) => {
        const cache = filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : filePath.endsWith('index.html')
            ? 'no-cache' // always revalidate, so a new deploy shows up immediately
            : 'public, max-age=3600';
        reply.header('Cache-Control', cache);
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: unknown non-API GETs get index.html (never cached, so deploys show up).
    if (serveSpa && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    throw notFound(`No route for ${req.method} ${req.url.split('?')[0]}`);
  });

  return app;
}
