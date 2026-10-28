// CDN check: verifies the storefront's static assets are delivered by the CDN
// edge (infra/cdn.local.conf, or the `cdn` container) and that the edge caches
// like a CDN should.
//   node scripts/cdn-check.js [--site=http://127.0.0.1:8088]
// The CDN address is not configured here: it is read from the site's index.html,
// exactly as a browser finds it.
const SITE = (process.argv.find((a) => a.startsWith('--site=')) || '--site=http://127.0.0.1:8088').slice(7);
const UA = { 'User-Agent': 'Mozilla/5.0 (cdn-check)' };

let failed = 0;
const check = (ok, name, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const get = (url, enc = 'br, gzip', extra = {}) => fetch(url, { headers: { ...UA, 'Accept-Encoding': enc, ...extra } });

console.log(`CDN check, site ${SITE}\n`);

// 1. The HTML document comes from the site and points at the CDN.
const html = await (await get(`${SITE}/`)).text();
const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const cdn = urls.length ? new URL(urls[0]).origin : '';
check(urls.length >= 2, 'index.html references entry JS + CSS on a CDN origin', cdn || 'no absolute asset URLs (built without CDN_URL?)');
if (!cdn) process.exit(1);
check(cdn !== new URL(SITE).origin, 'CDN is a different origin from the site', `${cdn} vs ${new URL(SITE).origin}`);

// 2. Every initial asset: served by the edge, Brotli, cached, CORS-enabled, immutable.
for (const url of urls) {
  const name = url.split('/').pop();
  const first = await get(url);
  await first.arrayBuffer();
  const again = await get(url);
  const bytes = Number(again.headers.get('content-length'));
  await again.arrayBuffer();
  check(again.headers.get('x-cdn-edge') !== null, `${name}: served by the edge`, again.headers.get('x-cdn-edge') || 'no X-CDN-Edge header');
  check(again.headers.get('x-cache') === 'HIT', `${name}: repeat request is a cache HIT`, `first ${first.headers.get('x-cache')}, then ${again.headers.get('x-cache')}`);
  check(again.headers.get('content-encoding') === 'br', `${name}: Brotli to a Brotli client`, `${again.headers.get('content-encoding')}, ${(bytes / 1024).toFixed(1)} KB`);
  check(again.headers.get('access-control-allow-origin') === '*', `${name}: CORS header for crossorigin module scripts`);
  check(/immutable/.test(again.headers.get('cache-control') || ''), `${name}: Cache-Control immutable`, again.headers.get('cache-control'));
}

// 3. Separate cache entries per encoding: a gzip-only client gets gzip, not Brotli.
const gz = await get(urls[0], 'gzip');
await gz.arrayBuffer();
check(gz.headers.get('content-encoding') === 'gzip', 'gzip-only client gets gzip (per-encoding cache variants)', gz.headers.get('content-encoding'));

// 4. Request collapsing: 200 simultaneous requests for an uncached URL → 1 origin fetch.
const cold = `${urls[0]}?collapse=${Date.now()}`;
const statuses = await Promise.all(Array.from({ length: 200 }, () => get(cold).then(async (r) => { await r.arrayBuffer(); return r.headers.get('x-cache'); })));
const tally = statuses.reduce((t, s) => ({ ...t, [s]: (t[s] || 0) + 1 }), {});
check(tally.MISS === 1, '200 concurrent cold requests → exactly 1 origin fetch (MISS)', JSON.stringify(tally));

// 5. Throughput from the edge cache.
const t0 = performance.now();
let n = 0;
await Promise.all(Array.from({ length: 50 }, async () => {
  for (let i = 0; i < 20; i++) { const r = await get(urls[0]); await r.arrayBuffer(); n++; }
}));
const sec = (performance.now() - t0) / 1000;
check(n === 1000, '1,000 cached asset requests served by the edge', `${Math.round(n / sec)} req/s, ${(sec * 1000 / n * 50).toFixed(1)} ms avg at 50 concurrent`);

// 6. The edge is static-only.
check((await get(`${cdn}/api/health`)).status === 404, 'edge refuses /api (404)');
check((await fetch(urls[0], { method: 'POST', headers: UA })).status === 403, 'edge refuses non-GET methods (403)');

console.log(`\n${failed === 0 ? 'ALL CDN CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed ? 1 : 0);
