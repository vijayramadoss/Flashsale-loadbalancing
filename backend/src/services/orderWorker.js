// Redis Streams consumer-group mechanics for the order writer.
// Kept separate from the process entry point (src/worker.js) so the tests can
// drive exactly the same code without spawning a process.
import { config } from '../config/env.js';
import { getRedis, keys, ORDER_GROUP } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { parseStreamEntry, persistReservation, publishOutcome } from './orderProcessor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acknowledge and then delete a processed message, so the stream only ever
// holds unprocessed work and Redis memory stays bounded.
async function ackAndDelete(id) {
  const stream = keys.orderStream();
  await getRedis().pipeline().xack(stream, ORDER_GROUP, id).xdel(stream, id).exec();
}

export async function ensureGroup(redis = getRedis()) {
  try {
    // '0' = also deliver messages that were added before the group existed.
    await redis.xgroup('CREATE', keys.orderStream(), ORDER_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!/BUSYGROUP/.test(err.message)) throw err;
  }
}

/**
 * Handles one job with a few quick in-process retries for transient errors
 * (e.g. a transaction write conflict between two workers). Returns true when
 * the message may be acknowledged, false to leave it pending for a later retry.
 */
export async function handleJob(job, deliveries = 1) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const outcome = await persistReservation(job);
      await publishOutcome(job, outcome);
      return true;
    } catch (err) {
      logger.warn('job attempt failed', { reservationId: job.reservationId, attempt, err: err.message });
      await sleep(100 * attempt);
    }
  }
  if (deliveries >= config.worker.maxDeliveries) {
    // Give up: compensate so the token isn't lost forever and the user is told.
    await publishOutcome(job, { status: 'FAILED', reason: 'PROCESSING_ERROR' });
    return true;
  }
  return false;
}

/**
 * Reads up to batchSize new messages (waiting at most blockMs) and processes
 * them sequentially, in queue order. Returns the number of messages read.
 * `blocking` must be a dedicated connection: XREADGROUP BLOCK holds it.
 */
export async function processBatch(blocking, consumer, { blockMs = config.worker.blockMs, count = config.worker.batchSize } = {}) {
  const stream = keys.orderStream();
  const res = await blocking.xreadgroup('GROUP', ORDER_GROUP, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>');
  if (!res) return 0;
  const entries = res[0][1];
  for (const entry of entries) {
    const job = parseStreamEntry(entry);
    if (await handleJob(job)) await ackAndDelete(job.messageId);
  }
  return entries.length;
}

/** Takes over messages left unacknowledged by a crashed or stuck consumer. */
export async function reclaimStale(consumer, idleMs = config.worker.claimIdleMs) {
  const redis = getRedis();
  const stream = keys.orderStream();
  const pending = await redis.xpending(stream, ORDER_GROUP, '-', '+', 100);
  let reclaimed = 0;
  for (const [id, , idle, deliveries] of pending) {
    if (idle < idleMs) continue;
    const claimed = await redis.xclaim(stream, ORDER_GROUP, consumer, idleMs, id);
    for (const entry of claimed) {
      if (!entry || !entry[1]) {
        await redis.xack(stream, ORDER_GROUP, id); // message body already gone: clear the dangling pending entry
        continue;
      }
      reclaimed++;
      if (await handleJob(parseStreamEntry(entry), deliveries + 1)) await ackAndDelete(id);
    }
  }
  return reclaimed;
}
