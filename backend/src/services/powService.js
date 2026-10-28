// Self-hosted proof-of-work bot check (no third-party CAPTCHA, no tracking).
//
// The server hands out a signed, expiring, single-use challenge. The browser
// must find a nonce such that SHA-256("<challenge>:<nonce>") starts with N zero
// bits — about 2^N hashes of work (N=16 ≈ 65k hashes ≈ well under a second for a
// person). Checking takes ONE hash. A bot farm running 10,000 accounts pays that
// cost 10,000 times, every time.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';
import { AppError } from '../lib/errors.js';

const secret = () => createHash('sha256').update(`pow:${config.jwtSecret}`).digest();
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);

export function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    return bits + (Math.clz32(n) - 28);
  }
  return bits;
}

export function issueChallenge(userId, difficulty = config.pow.difficulty) {
  const exp = Math.floor(Date.now() / 1000) + config.pow.ttlSec;
  const payload = `${randomBytes(12).toString('hex')}.${exp}.${difficulty}.${userId}`;
  return { challenge: `${payload}.${sign(payload)}`, difficulty, algorithm: 'SHA-256', expiresAt: new Date(exp * 1000).toISOString() };
}

/** Throws unless the solution is valid, unexpired, for this user, and not used before. */
export async function verifySolution(challenge, nonce, userId) {
  const parts = String(challenge || '').split('.');
  if (parts.length !== 5) throw new AppError(400, 'POW_INVALID', 'Invalid verification challenge');
  const [rnd, exp, difficulty, uid, sig] = parts;
  const expected = Buffer.from(sign(`${rnd}.${exp}.${difficulty}.${uid}`));
  if (expected.length !== Buffer.from(sig).length || !timingSafeEqual(expected, Buffer.from(sig))) throw new AppError(400, 'POW_INVALID', 'Invalid verification challenge');
  if (uid !== String(userId)) throw new AppError(400, 'POW_INVALID', 'This verification belongs to another session');
  if (Number(exp) * 1000 < Date.now()) throw new AppError(400, 'POW_EXPIRED', 'Verification expired — please try again');
  const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
  if (leadingZeroBits(digest) < Number(difficulty)) throw new AppError(400, 'POW_FAILED', 'Verification failed — please try again');
  // Single use: a solved challenge can't be replayed by a bot farm.
  const fresh = await getRedis().set(keys.powUsed(rnd), '1', 'EX', config.pow.ttlSec, 'NX');
  if (fresh !== 'OK') throw new AppError(400, 'POW_REUSED', 'This verification was already used');
}

/** Reference solver (tests, simulator). The browser uses the same algorithm in a Web Worker. */
export function solve(challenge, difficulty) {
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest('hex')) >= difficulty) return String(nonce);
  }
}
