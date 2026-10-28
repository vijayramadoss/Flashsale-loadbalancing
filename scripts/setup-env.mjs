// One-command setup: creates the .env files with freshly generated random secrets.
//   node scripts/setup-env.mjs            → .env (Docker) and backend/.env (local run)
// Existing files are never overwritten. The admin login is printed once at the end.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const adminPassword = rand(9);

// Fill a template: replace KEY=value lines for the keys we generate, keep everything else.
const fill = (template, values) =>
  fs.readFileSync(path.join(root, template), 'utf8')
    .split(/\r?\n/)
    .map((line) => {
      const key = line.split('=')[0];
      return key in values ? `${key}=${values[key]}` : line;
    })
    .join('\n');

const targets = [
  {
    file: '.env',
    template: '.env.docker.example',
    values: {
      JWT_SECRET: rand(48), PAYMENT_WEBHOOK_SECRET: rand(32), REDIS_PASSWORD: rand(24),
      ADMIN_PASSWORD: adminPassword, GRAFANA_ADMIN_PASSWORD: rand(12),
    },
  },
  {
    file: 'backend/.env',
    template: 'backend/.env.example',
    values: { JWT_SECRET: rand(48), ADMIN_PASSWORD: adminPassword },
  },
];

for (const t of targets) {
  const out = path.join(root, t.file);
  if (fs.existsSync(out)) { console.log(`skipped ${t.file} (already exists)`); continue; }
  fs.writeFileSync(out, fill(t.template, t.values));
  console.log(`created ${t.file}`);
}
console.log(`\nAdmin login for the store:  admin@flashsale.test  /  ${adminPassword}`);
console.log('(only shown for newly created files; it is stored in the .env files)');
