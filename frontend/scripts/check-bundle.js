// Bundle budget check (runs after `vite build`). Measures what a shopper must
// download before the store works — the entry JS + CSS referenced by
// index.html — and fails the build if its TRANSFER size exceeds the case
// study's 200 KB target.
//
// Transfer size = the Brotli files the server actually sends (precompress.js
// writes them; @fastify/static serves them with `preCompressed`). Gzip and raw
// sizes are reported too, for clients/CDNs without Brotli. Lazy chunks
// (other routes, admin dashboard) are listed separately.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BUDGET_BYTES = 200 * 1024;
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

const initial = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]));
const all = fs.readdirSync(path.join(dist, 'assets')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `assets/${f}`);

const size = (file) => {
  const buf = fs.readFileSync(path.join(dist, file));
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    br: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
};
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const row = (name, s) => `  ${name.padEnd(42)} ${kb(s.raw).padStart(10)} raw ${kb(s.gzip).padStart(9)} gzip ${kb(s.br).padStart(9)} br`;

const total = { raw: 0, gzip: 0, br: 0 };
console.log('\nInitial load (needed before the home page works):');
for (const f of initial) {
  const s = size(f);
  for (const k of Object.keys(total)) total[k] += s[k];
  console.log(row(f, s));
}
console.log(row('TOTAL', total) + `   (budget ${kb(BUDGET_BYTES)} transferred)`);

const lazy = all.filter((f) => !initial.has(f));
if (lazy.length) {
  const lazyTotal = { raw: 0, gzip: 0, br: 0 };
  for (const f of lazy) {
    const s = size(f);
    for (const k of Object.keys(lazyTotal)) lazyTotal[k] += s[k];
  }
  console.log(`Lazy chunks: ${lazy.length} files, ${kb(lazyTotal.br)} br / ${kb(lazyTotal.gzip)} gzip in total (loaded per route, prefetched when idle)`);
}

if (total.br > BUDGET_BYTES) {
  console.error(`\n✖ Initial bundle ${kb(total.br)} (Brotli) exceeds the ${kb(BUDGET_BYTES)} budget`);
  process.exit(1);
}
console.log(`\n✔ Initial bundle within budget: ${kb(total.br)} Brotli ≤ ${kb(BUDGET_BYTES)}  (gzip ${kb(total.gzip)}, raw ${kb(total.raw)})\n`);
