// Pure timing helpers (no React, no DOM) so they can be unit tested with node --test.

/**
 * Spreads requests out by ±20 % so 100k clients that loaded the page at the
 * same moment don't keep polling in lock-step (a "thundering herd").
 */
export function withJitter(ms, rand = Math.random) {
  return Math.round(ms * (0.8 + rand() * 0.4));
}

/**
 * How long to wait before re-fetching the public sale status.
 * Adaptive: rare while the sale is far away, frequent around launch,
 * stopped once the outcome can no longer change.
 */
export function salePollDelay({ state, msUntilStart, hidden = false }) {
  let ms;
  if (state === 'ENDED' || state === 'SOLD_OUT') return null; // nothing left to watch
  if (state === 'UPCOMING') {
    if (msUntilStart > 5 * 60_000) ms = 30_000;
    else if (msUntilStart > 60_000) ms = 10_000;
    else ms = 3_000; // the local countdown flips the button at T-0; polling only refreshes stock
  } else {
    ms = 2_000; // LIVE: keep the remaining-stock bar fresh
  }
  return hidden ? ms * 4 : ms; // background tabs poll 4× less
}

/**
 * Delay before the next poll of a queued reservation. Honours the server's
 * Retry-After hint, otherwise backs off exponentially (1 s, 1.5 s, 2.25 s … max 5 s).
 */
export function reservationPollDelay(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 10_000);
  return Math.min(1000 * 1.5 ** attempt, 5000);
}

/** Estimates the server-minus-client clock offset from one response, correcting for half the round-trip. */
export function clockOffset(serverTimeIso, sentAt, receivedAt) {
  const midpoint = sentAt + (receivedAt - sentAt) / 2;
  return Date.parse(serverTimeIso) - midpoint;
}
