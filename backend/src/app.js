import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config/env.js';
import { buildApiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');

// Builds the Express app without listening, so tests can drive it with supertest.
export function createApp() {
  const app = express();

  // Behind NGINX/ALB, req.ip must come from X-Forwarded-For (set by the proxy),
  // otherwise every user would share the proxy's IP for rate limiting.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: '10kb' }));

  app.use('/api', buildApiRouter());
  app.use('/api', notFoundHandler);

  // Optional: serve the built React app from the same origin (single-box
  // deployments). In production a CDN would serve these files instead.
  if (config.serveFrontend && fs.existsSync(frontendDist)) {
    // Vite emits content-hashed file names, so they can be cached "forever".
    app.use('/assets', express.static(path.join(frontendDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(frontendDist, { index: false, maxAge: '1h' }));
    // SPA fallback: any non-API GET returns index.html (never cached, so new deploys show up).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
