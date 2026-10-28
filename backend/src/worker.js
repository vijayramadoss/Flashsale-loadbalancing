// Background process: (1) turns queued flash-deal reservations into pending
// orders, (2) sweeps unpaid orders whose hold expired and returns their stock.
// Run one or more alongside the API (`npm run worker`); several workers share
// the queue through a consumer group, and the sweeper's conditional updates
// make it safe for more than one worker to sweep at the same time.
import os from 'node:os';
import { config } from './config/env.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { closeRedis, createRedis, getRedis, waitForRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { ensureGroup, processBatch, reclaimStale } from './services/orderWorker.js';
import { expireDueOrders } from './services/orderService.js';

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
  let lastSweep = 0;
  while (running) {
    try {
      const now = Date.now();
      if (now - lastReclaim > config.worker.claimIdleMs / 2) {
        lastReclaim = now;
        const n = await reclaimStale(consumer);
        if (n) logger.info('reclaimed stale messages', { count: n });
      }
      if (now - lastSweep > config.worker.sweepIntervalMs) {
        lastSweep = now;
        const n = await expireDueOrders();
        if (n) logger.info('expired unpaid orders', { count: n });
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
