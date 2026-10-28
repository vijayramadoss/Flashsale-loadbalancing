import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
});
