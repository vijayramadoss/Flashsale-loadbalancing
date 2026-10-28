// Writes max-quality Brotli (.br) and gzip (.gz) copies of every built text
// asset. The API's static server (and any CDN) serves these directly when the
// browser accepts them, so no CPU is spent compressing on each request and
// the best possible compression (Brotli q11) is used.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

let count = 0;
for (const file of walk(dist)) {
  if (!/\.(js|css|html|svg|json)$/.test(file)) continue;
  const buf = fs.readFileSync(file);
  if (buf.length < 1024) continue;
  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(buf, { level: 9 }));
  count++;
}
console.log(`precompressed ${count} files (.br + .gz)`);
