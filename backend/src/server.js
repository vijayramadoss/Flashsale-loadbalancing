// API process entry point. Stateless: it can be started any number of times
// (see cluster.js, or multiple containers behind NGINX) because all shared
// state lives in Redis and MongoDB.
import { config } from './config/env.js';
import { createApp } from './app.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { closeRedis, getRedis, waitForRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectMongo();
  await waitForRedis(getRedis());

  // A large accept backlog lets the kernel queue a burst of new connections
  // instead of refusing them while the event loop is busy (0 % dropped requests).
  const server = createApp().listen({ port: config.port, backlog: config.listenBacklog }, () => {
    logger.info('api listening', { port: config.port, env: config.nodeEnv });
  });
  // Keep-alive longer than the load balancer's idle timeout avoids sporadic
  // 502s caused by the server closing a socket the proxy is about to reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const shutdown = (signal) => {
    logger.info('api shutting down', { signal });
    // Stop accepting new connections, let in-flight requests finish.
    server.close(async () => {
      await closeRedis().catch(() => {});
      await disconnectMongo().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('api failed to start', { err: err.message });
  process.exit(1);
});
