// Request guards used as Fastify `preHandler` hooks on individual routes.
import { verifyToken } from '../services/authService.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { getRedis, keys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

// Stateless authentication: the JWT signature is checked with the shared
// secret, so ANY replica can authenticate ANY request with no session store
// and no database round-trip — the checkout hot path stays DB-free.
export async function authenticate(request) {
  const header = request.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  try {
    request.user = verifyToken(token);
  } catch {
    throw unauthorized('Session expired or invalid — please log in again');
  }
}

export async function requireAdmin(request) {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'admin') throw forbidden();
}

// First, cheap line of bot defence on sensitive endpoints: reject clients that
// don't even claim to be a browser. Spoofable, so it is layered with auth,
// one-per-customer limits and rate limiting (CAPTCHA / WAF in production).
const AUTOMATION_UA = /(curl|wget|python-requests|python-urllib|aiohttp|httpie|go-http-client|java\/|okhttp|libwww|scrapy|headlesschrome|phantomjs|bot\b|spider|crawler)/i;

export async function botGuard(request) {
  const ua = request.headers['user-agent'] || '';
  if (ua.length < 10 || AUTOMATION_UA.test(ua)) throw forbidden('Automated traffic is not allowed');
}

/**
 * Redis-backed fixed-window rate limiter. Counters live in Redis, so the limit
 * holds across every replica. Fails OPEN if Redis is unreachable — the limiter
 * must not take the whole site down (the deal endpoint needs Redis anyway).
 */
export function rateLimit({ bucket, max, windowSec, keyFn = (req) => req.ip }) {
  return async function rateLimitHook(request, reply) {
    let count;
    let ttlMs;
    try {
      [count, ttlMs] = await getRedis().fsRateLimit(keys.rateLimit(bucket, keyFn(request)), windowSec * 1000);
    } catch (err) {
      logger.warn('rate limiter unavailable, failing open', { bucket, err: err.message });
      return;
    }
    const resetSec = Math.max(1, Math.ceil(ttlMs / 1000));
    reply.header('RateLimit-Limit', String(max));
    reply.header('RateLimit-Remaining', String(Math.max(0, max - count)));
    reply.header('RateLimit-Reset', String(resetSec));
    if (count > max) {
      reply.header('Retry-After', String(resetSec));
      throw new AppError(429, 'RATE_LIMITED', `Too many requests — try again in ${resetSec}s`, { retryAfter: resetSec });
    }
  };
}
