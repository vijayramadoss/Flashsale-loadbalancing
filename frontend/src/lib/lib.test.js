import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withJitter, salePollDelay, reservationPollDelay, clockOffset } from './polling.js';
import { checkoutReducer, initialCheckout, canSubmit, MAX_AUTO_RETRIES } from './checkout.js';
import { formatCountdown } from './format.js';

test('jitter stays within ±20 %', () => {
  assert.equal(withJitter(1000, () => 0), 800);
  assert.equal(withJitter(1000, () => 1), 1200);
});

test('sale polling adapts to how close the launch is and stops when final', () => {
  assert.equal(salePollDelay({ state: 'UPCOMING', msUntilStart: 3_600_000 }), 30_000);
  assert.equal(salePollDelay({ state: 'UPCOMING', msUntilStart: 120_000 }), 10_000);
  assert.equal(salePollDelay({ state: 'UPCOMING', msUntilStart: 5_000 }), 3_000);
  assert.equal(salePollDelay({ state: 'LIVE' }), 2_000);
  assert.equal(salePollDelay({ state: 'LIVE', hidden: true }), 8_000);
  assert.equal(salePollDelay({ state: 'SOLD_OUT' }), null);
  assert.equal(salePollDelay({ state: 'ENDED' }), null);
});

test('reservation polling honours Retry-After, else backs off to a 5 s cap', () => {
  assert.equal(reservationPollDelay(0, 2), 2000);
  assert.equal(reservationPollDelay(0), 1000);
  assert.equal(reservationPollDelay(1), 1500);
  assert.equal(reservationPollDelay(20), 5000);
});

test('clock offset corrects for half the round trip', () => {
  // Client clock is 10 s behind; request took 200 ms.
  const offset = clockOffset(new Date(20_100).toISOString(), 10_000, 10_200);
  assert.equal(offset, 10_000);
});

test('reserve: happy path idle → submitting → queued → reserved', () => {
  let s = checkoutReducer(initialCheckout, { type: 'SUBMIT' });
  assert.equal(s.phase, 'submitting');
  assert.equal(s.optimistic, true);
  assert.equal(canSubmit(s.phase), false, 'button is locked while submitting');
  s = checkoutReducer(s, { type: 'ACCEPTED', status: 'QUEUED', reservationId: 'r1', trackingUrl: '/api/checkout/r1' });
  assert.equal(s.phase, 'queued');
  assert.equal(canSubmit(s.phase), false);
  s = checkoutReducer(s, { type: 'STATUS', status: 'RESERVED', orderId: 'o1' });
  assert.equal(s.phase, 'reserved');
  assert.equal(s.orderId, 'o1');
});

test('reserve: sold out rolls back the optimistic update', () => {
  let s = checkoutReducer(initialCheckout, { type: 'SUBMIT' });
  s = checkoutReducer(s, { type: 'REJECTED', code: 'SOLD_OUT', message: 'gone' });
  assert.equal(s.phase, 'soldOut');
  assert.equal(s.optimistic, false);
});

test('reserve: transient errors auto-retry a bounded number of times, then surface', () => {
  let s = initialCheckout;
  for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
    s = checkoutReducer(s, { type: 'SUBMIT' });
    s = checkoutReducer(s, { type: 'REJECTED', code: 'RATE_LIMITED', message: 'slow down', retryAfter: 3 });
    assert.equal(s.phase, 'retrying');
    assert.equal(s.retryInSec, 3);
  }
  s = checkoutReducer(s, { type: 'SUBMIT' });
  s = checkoutReducer(s, { type: 'REJECTED', code: 'RATE_LIMITED', message: 'slow down' });
  assert.equal(s.phase, 'error');
  assert.equal(canSubmit(s.phase), true, 'user can retry manually');
});

test('reserve: a repeat click whose reservation is already RESERVED goes straight to checkout', () => {
  const s = checkoutReducer(checkoutReducer(initialCheckout, { type: 'SUBMIT' }), { type: 'ACCEPTED', status: 'RESERVED', reservationId: 'r1', orderId: 'o9' });
  assert.equal(s.phase, 'reserved');
  assert.equal(s.orderId, 'o9');
});

test('countdown formatting', () => {
  assert.equal(formatCountdown(3_725_000), '01:02:05');
  assert.equal(formatCountdown(-5), '00:00:00');
  assert.equal(formatCountdown(2 * 86_400_000 + 1000), '2d 00:00:01');
});
