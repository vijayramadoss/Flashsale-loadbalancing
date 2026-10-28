import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CDN: when CDN_URL is set at build time, every built asset (entry JS/CSS, lazy
// chunks, images) is referenced from the CDN origin instead of the site's own
// origin. HTML and /api stay on the site. `vite build --mode cdn` uses the
// local edge (infra/cdn.local.conf) unless CDN_URL overrides it.
export default defineConfig(({ mode }) => {
  const cdnUrl = (process.env.CDN_URL || (mode === 'cdn' ? 'http://127.0.0.1:8090' : '')).replace(/\/$/, '');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Same-origin API in development: the browser talks to Vite, Vite forwards /api.
      proxy: { '/api': 'http://localhost:4000' },
    },
    build: {
      target: 'es2020',
      // Content-hashed file names (Vite default) → assets can be CDN-cached forever.
      assetsInlineLimit: 4096,
      reportCompressedSize: true,
    },
    experimental: cdnUrl ? { renderBuiltUrl: (filename) => `${cdnUrl}/${filename}` } : {},
  };
});
