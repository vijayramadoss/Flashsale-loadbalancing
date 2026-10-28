import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { setup, teardown, resetData, UA } from './helpers.js';

const app = createApp();
const post = (path, body) => request(app).post(path).set('User-Agent', UA).send(body);

before(setup);
after(teardown);
beforeEach(resetData);

test('register creates a customer, returns a token and never the password hash', async () => {
  const res = await post('/api/auth/register', { name: 'Asha', email: 'Asha@Example.test', password: 'password123' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'asha@example.test'); // normalised
  assert.equal(res.body.user.role, 'customer');
  assert.equal(res.body.user.passwordHash, undefined);
  const stored = await User.findOne({ email: 'asha@example.test' }).select('+passwordHash');
  assert.match(stored.passwordHash, /^\$2[aby]\$/); // bcrypt hash, not plaintext
});

test('register ignores an attempt to self-assign the admin role', async () => {
  const res = await post('/api/auth/register', { name: 'Mallory', email: 'm@example.test', password: 'password123', role: 'admin' });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'customer');
});

test('register rejects duplicate emails and invalid input', async () => {
  await post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const dup = await post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');

  const bad = await post('/api/auth/register', { name: 'A', email: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['email', 'name', 'password']);
});

test('login succeeds with correct credentials and gives the same error for wrong password or unknown email', async () => {
  await post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const ok = await post('/api/auth/login', { email: 'a@example.test', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  const wrongPw = await post('/api/auth/login', { email: 'a@example.test', password: 'wrong-password' });
  const unknown = await post('/api/auth/login', { email: 'ghost@example.test', password: 'password123' });
  assert.equal(wrongPw.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrongPw.body, unknown.body); // no account enumeration
});

test('/auth/me requires a valid, untampered token', async () => {
  const { body } = await post('/api/auth/register', { name: 'Asha', email: 'a@example.test', password: 'password123' });
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'a@example.test');

  assert.equal((await request(app).get('/api/auth/me')).status, 401);
  const tampered = body.token.slice(0, -2) + (body.token.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tampered}`)).status, 401);
});

test('malformed JSON gets a clean 400, not a stack trace', async () => {
  const res = await request(app).post('/api/auth/login').set('User-Agent', UA).set('Content-Type', 'application/json').send('{"email":');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(res.body), /at .*\.js/);
});
