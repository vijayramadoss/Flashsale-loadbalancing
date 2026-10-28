// Virtual waiting room for flash deals (the Queue-it / Shopify-checkout-queue pattern).
//
//  * Before T-0 shoppers JOIN (after passing the proof-of-work check). Each
//    gets a RANDOM score, so at T-0 the order is a fair lottery — being the
//    fastest clicker (or a bot) gives no advantage. Later joiners queue behind.
//  * From T-0 the room releases `releasePerSec` shoppers per second. A shopper
//    at position r is admitted at  startsAt + r / releasePerSec — computed, not
//    stored, so there is no background job and every replica agrees.
//  * An admitted shopper receives a short-lived signed admission token; the
//    reserve endpoint refuses deals with a waiting room unless it is presented.
//
// Effect: instead of 10,000 "Buy now" requests in the first second, the backend
// sees a steady releasePerSec, and the shopper sees a position + ETA.
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';
import { AppError, notFound } from '../lib/errors.js';
import { getDealStatus, isObjectId } from './dealService.js';

const AUDIENCE = 'deal-admission';

async function dealInfo(dealId) {
  if (!isObjectId(dealId)) throw notFound('Deal not found');
  const d = await getDealStatus(dealId); // Redis-only read (primes on a miss)
  if (!d.waitingRoom?.enabled) throw new AppError(409, 'NO_WAITING_ROOM', 'This deal has no waiting room');
  return d;
}

export async function join(dealId, userId) {
  const d = await dealInfo(dealId);
  if (d.state === 'ENDED') throw new AppError(409, 'DEAL_ENDED', 'This deal has ended');
  const now = Date.now();
  const startsAt = Date.parse(d.startsAt);
  // Pre-launch: random place in [0,1). After launch: behind everyone, in join order.
  const score = now < startsAt ? Math.random() : 1 + (now - startsAt) / 1e9;
  await getRedis().zadd(keys.waitingRoom(dealId), 'NX', score, String(userId)); // NX: re-joining keeps your place
  return status(dealId, userId, d);
}

export async function status(dealId, userId, deal) {
  const d = deal || (await dealInfo(dealId));
  const redis = getRedis();
  const key = keys.waitingRoom(dealId);
  const [rank, size] = await Promise.all([redis.zrank(key, String(userId)), redis.zcard(key)]);
  const base = { dealId, queueSize: size, startsAt: d.startsAt, releasePerSec: d.waitingRoom.releasePerSec, serverTime: new Date().toISOString() };
  if (rank === null) return { ...base, phase: 'NOT_JOINED' };
  const now = Date.now();
  const startsAt = Date.parse(d.startsAt);
  if (now < startsAt) return { ...base, phase: 'WAITING_FOR_START', joined: true };
  if (d.state === 'SOLD_OUT' || d.state === 'ENDED') return { ...base, phase: d.state, position: rank + 1 };

  const admitAt = startsAt + (rank / d.waitingRoom.releasePerSec) * 1000;
  if (now < admitAt) {
    return { ...base, phase: 'QUEUED', position: rank + 1, ahead: rank, admitAt: new Date(admitAt).toISOString(), etaSec: Math.ceil((admitAt - now) / 1000) };
  }
  const admissionToken = jwt.sign({ deal: String(dealId) }, config.jwtSecret, {
    subject: String(userId),
    audience: AUDIENCE,
    expiresIn: config.waitingRoom.admissionTtlSec,
    algorithm: 'HS256',
  });
  return { ...base, phase: 'ADMITTED', position: rank + 1, admissionToken, admissionExpiresInSec: config.waitingRoom.admissionTtlSec };
}

/** Called by the reserve endpoint for deals that have a waiting room. */
export function verifyAdmission(token, dealId, userId) {
  try {
    const p = jwt.verify(String(token || ''), config.jwtSecret, { audience: AUDIENCE, subject: String(userId), algorithms: ['HS256'] });
    return p.deal === String(dealId);
  } catch {
    return false;
  }
}

export async function roomSize(dealId) {
  return getRedis().zcard(keys.waitingRoom(dealId));
}
