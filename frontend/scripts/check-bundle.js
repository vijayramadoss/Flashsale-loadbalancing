// Bundle budget check (runs after `vite build`). Measures what a buyer must
// download before the sale page can work — the entry JS + CSS referenced by
// index.html — and fails the build if it exceeds the case study's 200 KB target.
// Lazy chunks (the admin dashboard) are reported separately.
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
  return { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
};
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

let rawTotal = 0;
let gzipTotal = 0;
console.log('\nInitial load (blocks the sale page):');
for (const f of initial) {
  const s = size(f);
  rawTotal += s.raw;
  gzipTotal += s.gzip;
  console.log(`  ${f.padEnd(40)} ${kb(s.raw).padStart(10)} raw  ${kb(s.gzip).padStart(9)} gzip`);
}
console.log(`  ${'TOTAL'.padEnd(40)} ${kb(rawTotal).padStart(10)} raw  ${kb(gzipTotal).padStart(9)} gzip   (budget ${kb(BUDGET_BYTES)})`);

const lazy = all.filter((f) => !initial.has(f));
if (lazy.length) {
  console.log('Lazy chunks (loaded on demand):');
  for (const f of lazy) {
    const s = size(f);
    console.log(`  ${f.padEnd(40)} ${kb(s.raw).padStart(10)} raw  ${kb(s.gzip).padStart(9)} gzip`);
  }
}

// We hold ourselves to the stricter reading of the target: uncompressed size.
if (rawTotal > BUDGET_BYTES) {
  console.error(`\n✖ Initial bundle ${kb(rawTotal)} exceeds the ${kb(BUDGET_BYTES)} budget`);
  process.exit(1);
}
console.log(`\n✔ Initial bundle within budget (${kb(rawTotal)} raw / ${kb(gzipTotal)} gzip ≤ ${kb(BUDGET_BYTES)})\n`);
