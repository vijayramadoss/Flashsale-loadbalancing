// Order-writer process: consumes reservations from the Redis Stream and
// persists them to MongoDB. Run one or more of these alongside the API
// (`npm run worker`). Several workers share the load through a consumer
// group; each message is delivered to exactly one of them.
import os from 'node:os';
import { config } from './config/env.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { closeRedis, createRedis, getRedis, waitForRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { ensureGroup, processBatch, reclaimStale } from './services/orderWorker.js';

const consumer = `${os.hostname()}-${process.pid}`;
let running = true;

async function run() {
  await connectMongo();
  await waitForRedis(getRedis());
  // Blocking reads need their own connection so they don't stall other commands.
  const blocking = createRedis('worker-blocking');
  await waitForRedis(blocking);
  await ensureGroup();
  logger.info('order worker started', { consumer });

  let lastReclaim = 0;
  while (running) {
    try {
      if (Date.now() - lastReclaim > config.worker.claimIdleMs / 2) {
        lastReclaim = Date.now();
        const n = await reclaimStale(consumer);
        if (n) logger.info('reclaimed stale messages', { count: n });
      }
      await processBatch(blocking, consumer);
    } catch (err) {
      logger.error('worker loop error', { err: err.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Graceful exit: the in-flight batch has finished, nothing is half-written.
  blocking.disconnect();
  await closeRedis();
  await disconnectMongo();
  logger.info('order worker stopped');
}

function shutdown(signal) {
  logger.info('worker shutting down', { signal });
  running = false;
  setTimeout(() => process.exit(1), 15000).unref(); // hard stop if something hangs
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch((err) => {
  logger.error('worker failed to start', { err: err.message });
  process.exit(1);
});
