// Waiting room + proof-of-work bot check.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDeal } from '../src/services/dealService.js';
import { leadingZeroBits, solve } from '../src/services/powService.js';
import { setup, teardown, resetData, client, makeUser, makeProduct, sleep } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

async function roomDeal({ startsInMs = 400, releasePerSec = 5, stock = 50 } = {}) {
  const p = await makeProduct();
  const startsAt = new Date(Date.now() + startsInMs);
  return createDeal({ sku: p.variants[0].sku, title: 'Room deal', dealPriceCents: 1_000_000, totalStock: stock, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), waitingRoom: { enabled: true, releasePerSec } });
}

async function join(auth, dealId) {
  const ch = (await api.get('/api/pow/challenge', { auth })).body;
  return api.post(`/api/deals/${dealId}/queue`, { challenge: ch.challenge, nonce: solve(ch.challenge, ch.difficulty) }, { auth });
}

test('proof-of-work: leading-zero counting, wrong / reused / foreign solutions are rejected', async () => {
  assert.equal(leadingZeroBits('0000ff'), 16);
  assert.equal(leadingZeroBits('1f'), 3);
  assert.equal(leadingZeroBits('8'), 0);
  const deal = await roomDeal();
  const u = await makeUser();
  const ch = (await api.get('/api/pow/challenge', { auth: u.auth })).body;
  assert.equal(ch.algorithm, 'SHA-256');
  const nonce = solve(ch.challenge, ch.difficulty);
  assert.ok(leadingZeroBits(createHash('sha256').update(`${ch.challenge}:${nonce}`).digest('hex')) >= ch.difficulty);

  let bad = '0';
  while (leadingZeroBits(createHash('sha256').update(`${ch.challenge}:${bad}`).digest('hex')) >= ch.difficulty) bad += '1';
  assert.equal((await api.post(`/api/deals/${deal._id}/queue`, { challenge: ch.challenge, nonce: bad }, { auth: u.auth })).body.error.code, 'POW_FAILED');
  const other = await makeUser();
  assert.equal((await api.post(`/api/deals/${deal._id}/queue`, { challenge: ch.challenge, nonce }, { auth: other.auth })).body.error.code, 'POW_INVALID', 'bound to the user');
  assert.equal((await api.post(`/api/deals/${deal._id}/queue`, { challenge: ch.challenge, nonce }, { auth: u.auth })).status, 200);
  assert.equal((await api.post(`/api/deals/${deal._id}/queue`, { challenge: ch.challenge, nonce }, { auth: u.auth })).body.error.code, 'POW_REUSED', 'single use');
  const forged = ch.challenge.replace(/\.(\d+)\.(\d+)\./, '.$1.1.');
  assert.equal((await api.post(`/api/deals/${deal._id}/queue`, { challenge: forged, nonce: '0' }, { auth: u.auth })).body.error.code, 'POW_INVALID', 'difficulty cannot be edited');
});

test('waiting room: join before launch → random place at T-0 → admitted at the release rate → token required to reserve', async () => {
  const deal = await roomDeal({ startsInMs: 500, releasePerSec: 5 });
  const users = await Promise.all(Array.from({ length: 8 }, () => makeUser()));
  for (const u of users) assert.equal((await join(u.auth, deal._id)).body.queue.phase, 'WAITING_FOR_START');

  // Before launch nobody may reserve, with or without a queue position.
  assert.equal((await api.post(`/api/deals/${deal._id}/reserve`, undefined, { auth: users[0].auth })).body.error.code, 'ADMISSION_REQUIRED');

  await sleep(650); // T-0 passed
  const statuses = await Promise.all(users.map(async (u) => (await api.get(`/api/deals/${deal._id}/queue`, { auth: u.auth })).body.queue));
  const positions = statuses.map((s) => s.position).sort((a, b) => a - b);
  assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8], 'every shopper got a distinct place');
  const admitted = statuses.filter((s) => s.phase === 'ADMITTED');
  assert.ok(admitted.length >= 1 && admitted.length <= 3, `only the first ~${5 * 0.2} per 200 ms are in (got ${admitted.length})`);
  const waiting = statuses.find((s) => s.phase === 'QUEUED');
  assert.ok(waiting.etaSec >= 1 && waiting.admitAt);

  // The admitted shopper reserves with the token; a token for someone else / another deal does not work.
  const first = users[statuses.indexOf(admitted[0])];
  const token = admitted[0].admissionToken;
  const thief = users.find((u) => u !== first);
  assert.equal((await api.post(`/api/deals/${deal._id}/reserve`, undefined, { auth: thief.auth, headers: { 'x-admission-token': token } })).status, 403);
  const ok = await api.post(`/api/deals/${deal._id}/reserve`, undefined, { auth: first.auth, headers: { 'x-admission-token': token } });
  assert.equal(ok.status, 202);

  await sleep(1500); // at 5/s, everyone is through after ~1.6 s
  const later = await Promise.all(users.map(async (u) => (await api.get(`/api/deals/${deal._id}/queue`, { auth: u.auth })).body.queue.phase));
  assert.ok(later.every((p) => p === 'ADMITTED'), later.join(','));
});

test('joining after launch puts you behind everyone who was already waiting', async () => {
  const deal = await roomDeal({ startsInMs: 200, releasePerSec: 1 });
  const early = await Promise.all(Array.from({ length: 3 }, () => makeUser()));
  for (const u of early) await join(u.auth, deal._id);
  await sleep(300);
  const late = await makeUser();
  const status = (await join(late.auth, deal._id)).body.queue;
  assert.equal(status.position, 4);
  assert.equal(status.phase, 'QUEUED');
  const again = (await join(late.auth, deal._id)).body.queue;
  assert.equal(again.position, 4, 're-joining keeps your place');
});

test('deals without a waiting room work as before (no token needed); queue endpoints say so', async () => {
  const p = await makeProduct();
  const deal = await createDeal({ sku: p.variants[0].sku, title: 'Open deal', dealPriceCents: 1_000_000, totalStock: 5, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3_600_000) });
  const u = await makeUser();
  assert.equal((await api.post(`/api/deals/${deal._id}/reserve`, undefined, { auth: u.auth })).status, 202);
  assert.equal((await join(u.auth, deal._id)).body.error.code, 'NO_WAITING_ROOM');
  const status = (await api.get(`/api/deals/${deal._id}`)).body.deal;
  assert.equal(status.waitingRoom.enabled, false);
});
