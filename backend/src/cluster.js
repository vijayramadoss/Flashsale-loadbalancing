// Runs one API process per CPU core on a single machine. Node's cluster
// module lets the workers share the listening port; the primary distributes
// incoming connections between them (round-robin on all platforms except Windows,
// where the OS balances them). On multiple machines the same role is played by
// NGINX / an ALB (see infra/nginx.conf).
import cluster from 'node:cluster';
import os from 'node:os';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';

const count = config.webConcurrency || os.availableParallelism();

if (cluster.isPrimary) {
  logger.info('cluster primary starting', { workers: count });
  for (let i = 0; i < count; i++) cluster.fork();

  let stopping = false;
  cluster.on('exit', (worker, code) => {
    if (stopping) return;
    // A crashed replica is replaced; the others keep serving meanwhile.
    logger.warn('api worker died, restarting', { pid: worker.process.pid, code });
    cluster.fork();
  });
  const stop = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await import('./server.js');
}
