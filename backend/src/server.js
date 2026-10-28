// API process entry point. Stateless: start it any number of times (cluster.js,
// or containers behind NGINX) — all shared state lives in Redis and MongoDB.
import { config } from './config/env.js';
import { buildApp } from './app.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { closeRedis, getRedis, waitForRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectMongo();
  await waitForRedis(getRedis());
  const app = await buildApp();
  // A large accept backlog lets the kernel queue a burst of new connections
  // instead of refusing them while the event loop is busy (0 % dropped requests).
  await app.listen({ port: config.port, host: '0.0.0.0', backlog: config.listenBacklog });
  logger.info('api listening', { port: config.port, env: config.nodeEnv });

  const shutdown = async (signal) => {
    logger.info('api shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.close(); // stops accepting, waits for in-flight requests
    await closeRedis().catch(() => {});
    await disconnectMongo().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('api failed to start', { err: err.message });
  process.exit(1);
});
