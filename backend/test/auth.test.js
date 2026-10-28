import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../src/models/User.js';
import { setup, teardown, resetData, client, makeUser } from './helpers.js';

let app;
let api;
before(async () => {
  app = await setup();
  api = client(app);
});
after(() => teardown(app));
beforeEach(resetData);

test('register creates a customer, returns a token and never the password hash', async () => {
  const res = await api.post('/api/auth/register', { name: 'Asha', email: 'Asha@Example.test', password: 'password123' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'asha@example.test');
  assert.equal(res.body.user.role, 'customer');
  assert.equal(res.body.user.passwordHash, undefined);
  const stored = await User.findOne({ email: 'asha@example.test' }).select('+passwordHash');
  assert.match(stored.passwordHash, /^\$2[aby]\$/);
});

test('register rejects unknown fields such as a self-assigned admin role', async () => {
  const res = await api.post('/api/auth/register', { name: 'Mallory', email: 'm@example.test', password: 'password123', role: 'admin' });
  assert.equal(res.status, 400);
  assert.equal(await User.countDocuments({ email: 'm@example.test' }), 0);
});

test('register rejects duplicate emails and invalid input', async () => {
  await api.post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const dup = await api.post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');

  const bad = await api.post('/api/auth/register', { name: 'A', email: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual([...new Set(bad.body.error.details.map((d) => d.field))].sort(), ['email', 'name', 'password']);
});

test('login works and gives the same error for a wrong password or an unknown email', async () => {
  await api.post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const ok = await api.post('/api/auth/login', { email: 'a@example.test', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const wrongPw = await api.post('/api/auth/login', { email: 'a@example.test', password: 'wrong-password' });
  const unknown = await api.post('/api/auth/login', { email: 'ghost@example.test', password: 'password123' });
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(wrongPw.body, unknown.body);
});

test('/auth/me requires a valid, untampered token', async () => {
  const { body } = await api.post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const me = await api.get('/api/auth/me', { auth: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'a@example.test');
  assert.equal((await api.get('/api/auth/me')).status, 401);
  const tampered = body.token.slice(0, -2) + (body.token.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await api.get('/api/auth/me', { auth: { authorization: `Bearer ${tampered}` } })).status, 401);
});

test('malformed JSON gets a clean 400, not a stack trace', async () => {
  const res = await api.post('/api/auth/login', '{"email":');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(res.body), /at .*\.js/);
});

test('address book: add (first becomes default), validate, update default, delete', async () => {
  const { auth } = await makeUser({ withAddress: false });
  const valid = { fullName: 'Asha Rao', phone: '9876543210', line1: '4 Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' };
  const first = await api.post('/api/account/addresses', valid, { auth });
  assert.equal(first.status, 201);
  assert.equal(first.body.address.isDefault, true);

  const bad = await api.post('/api/account/addresses', { ...valid, phone: '12345', pincode: 'ABC' }, { auth });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['phone', 'pincode']);

  const second = await api.post('/api/account/addresses', { ...valid, label: 'Work', isDefault: true }, { auth });
  const list = await api.get('/api/account/addresses', { auth });
  assert.equal(list.body.addresses.length, 2);
  assert.deepEqual(list.body.addresses.map((a) => a.isDefault), [false, true]);

  assert.equal((await api.del(`/api/account/addresses/${second.body.address.id}`, { auth })).status, 204);
  const after = await api.get('/api/account/addresses', { auth });
  assert.equal(after.body.addresses.length, 1);
  assert.equal(after.body.addresses[0].isDefault, true, 'remaining address becomes the default');
});
