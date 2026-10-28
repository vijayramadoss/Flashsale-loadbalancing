// Central, validated configuration. Every other module imports from here
// instead of reading process.env directly, so misconfiguration fails fast at boot.

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: num(process.env.PORT, 4000),
  listenBacklog: num(process.env.LISTEN_BACKLOG, 4096),

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/flashsale?replicaSet=rs0',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
  // Namespaces every Redis key so tests (and multiple environments) never collide.
  redisPrefix: process.env.REDIS_PREFIX || 'fs:',

  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 10),

  // Addresses/CIDRs of the reverse proxies in front of the app (NGINX/ALB),
  // comma-separated, e.g. "10.0.0.0/8" or "loopback". Only requests arriving
  // from these may set the client IP via X-Forwarded-For. Empty = trust nobody.
  trustProxy: (process.env.TRUST_PROXY || '').trim() === '0' ? '' : (process.env.TRUST_PROXY || '').trim(),

  rateLimit: {
    windowSec: num(process.env.RATE_LIMIT_WINDOW_SEC, 10),
    ipMax: num(process.env.RATE_LIMIT_IP_MAX, 60),
    checkoutUserMax: num(process.env.RATE_LIMIT_CHECKOUT_USER_MAX, 5),
    authIpMax: num(process.env.RATE_LIMIT_AUTH_IP_MAX, 20),
  },

  worker: {
    batchSize: num(process.env.WORKER_BATCH_SIZE, 50),
    blockMs: num(process.env.WORKER_BLOCK_MS, 2000),
    maxDeliveries: num(process.env.WORKER_MAX_DELIVERIES, 5),
    // Pending messages idle longer than this are assumed to belong to a crashed consumer.
    claimIdleMs: num(process.env.WORKER_CLAIM_IDLE_MS, 30000),
    // How often the worker looks for unpaid orders whose hold has expired.
    sweepIntervalMs: num(process.env.WORKER_SWEEP_INTERVAL_MS, 10000),
  },

  orders: {
    // Stock is held for a cart order this long while the customer pays.
    cartHoldMinutes: num(process.env.CART_HOLD_MINUTES, 15),
    maxLines: 10,
    maxQtyPerLine: 5,
  },

  // Seconds a catalog listing is cached in Redis (shared by every replica).
  catalogCacheSec: num(process.env.CATALOG_CACHE_SEC, 30),

  webConcurrency: num(process.env.WEB_CONCURRENCY, 0), // 0 = one per CPU core
  serveFrontend: process.env.SERVE_FRONTEND === 'true',

  adminEmail: process.env.ADMIN_EMAIL || 'admin@flashsale.test',
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

if (!config.jwtSecret || config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters long (see backend/.env.example)');
}
