import { getRedis, keys } from '../lib/redis.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Redis-backed fixed-window limiter. Counters live in Redis (not process
// memory) so the limit holds across every replica behind the load balancer.
//
// Fails OPEN if Redis is unreachable: the limiter must not become the reason
// the whole site is down. The checkout itself still needs Redis and will
// report 503 on its own in that case.
export function rateLimit({ bucket, max, windowSec, keyFn = (req) => req.ip }) {
  return async (req, res, next) => {
    let count;
    let ttlMs;
    try {
      [count, ttlMs] = await getRedis().fsRateLimit(keys.rateLimit(bucket, keyFn(req)), windowSec * 1000);
    } catch (err) {
      logger.warn('rate limiter unavailable, failing open', { bucket, err: err.message });
      return next();
    }
    const resetSec = Math.max(1, Math.ceil(ttlMs / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.set('RateLimit-Reset', String(resetSec));
    if (count > max) {
      res.set('Retry-After', String(resetSec));
      return next(new AppError(429, 'RATE_LIMITED', `Too many requests — try again in ${resetSec}s`, { retryAfter: resetSec }));
    }
    next();
  };
}
