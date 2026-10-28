import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from './api.js';
import { checkoutReducer, initialCheckout } from './lib/checkout.js';
import { clockOffset, reservationPollDelay, salePollDelay, withJitter } from './lib/polling.js';

/**
 * Live sale status with adaptive polling (see salePollDelay) and server-clock
 * sync. Polling pauses its pace in background tabs and stops when the sale is
 * final. Network errors keep the last good data on screen and retry.
 */
export function useSaleStatus(saleId) {
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0); // serverTime - clientTime (ms)

  useEffect(() => {
    if (!saleId) return undefined;
    let cancelled = false;
    let timer;

    const load = async () => {
      const sentAt = Date.now();
      try {
        const { data } = await api(`/sales/${saleId}`, { auth: false });
        if (cancelled) return;
        const off = clockOffset(data.sale.serverTime, sentAt, Date.now());
        setOffset(off);
        setSale(data.sale);
        setError(null);
        schedule(data.sale, off);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        timer = setTimeout(load, withJitter(5000));
      }
    };

    const schedule = (s, off) => {
      const msUntilStart = Date.parse(s.startsAt) - (Date.now() + off);
      const delay = salePollDelay({ state: s.state, msUntilStart, hidden: document.hidden });
      if (delay !== null) timer = setTimeout(load, withJitter(delay));
    };

    // Coming back to the tab → refresh immediately instead of waiting out a long background interval.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [saleId]);

  return { sale, error, offset };
}

const resumeKey = (saleId) => `fs.reservation.${saleId}`;

/**
 * Checkout flow for one sale: submit with a synchronous click lock, then poll
 * the tracking URL until the worker confirms or fails the order.
 */
export function useCheckout(saleId, userId) {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckout);
  // A ref, not state: React state updates are asynchronous, so two clicks in
  // the same frame would both see "idle". The ref flips synchronously on the
  // first click and the second one returns immediately — no duplicate payload.
  const inFlight = useRef(false);

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: 'SUBMIT' });
    try {
      const { data } = await api('/checkout', { method: 'POST', body: { saleId } });
      dispatch({ type: 'ACCEPTED', status: data.status, reservationId: data.reservationId, trackingUrl: data.trackingUrl });
      try {
        sessionStorage.setItem(resumeKey(saleId), JSON.stringify({ userId, trackingUrl: data.trackingUrl, reservationId: data.reservationId }));
      } catch { /* not critical */ }
    } catch (err) {
      dispatch({ type: 'REJECTED', code: err.code, message: err.message, retryAfter: err.retryAfter });
    } finally {
      inFlight.current = false;
    }
  }, [saleId, userId]);

  // Resume tracking after a page refresh.
  useEffect(() => {
    dispatch({ type: 'RESET' });
    try {
      const saved = JSON.parse(sessionStorage.getItem(resumeKey(saleId)) || 'null');
      if (saved && saved.userId === userId) dispatch({ type: 'ACCEPTED', status: 'QUEUED', ...saved });
    } catch { /* ignore */ }
  }, [saleId, userId]);

  // Automatic retry for transient rejections (429 / 503 / network), with a visible countdown.
  const [retryIn, setRetryIn] = useState(0);
  useEffect(() => {
    if (state.phase !== 'retrying') return undefined;
    const deadline = Date.now() + withJitter(state.retryInSec * 1000);
    setRetryIn(Math.ceil((deadline - Date.now()) / 1000));
    const tick = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        clearInterval(tick);
        submit();
      } else setRetryIn(Math.ceil(left / 1000));
    }, 250);
    return () => clearInterval(tick);
  }, [state.phase, state.retryInSec, state.attempts, submit]);

  // Poll the reservation until it is final.
  useEffect(() => {
    if (state.phase !== 'queued' || !state.trackingUrl) return undefined;
    let cancelled = false;
    let timer;
    let attempt = 0;
    const poll = async () => {
      let delay;
      try {
        const { data, retryAfter } = await api(state.trackingUrl);
        if (cancelled) return;
        const r = data.reservation;
        if (r.status !== 'QUEUED') {
          dispatch({ type: 'STATUS', status: r.status, orderId: r.orderId, reason: r.reason });
          if (r.status === 'FAILED') sessionStorage.removeItem(resumeKey(saleId));
          return;
        }
        delay = reservationPollDelay(attempt++, retryAfter);
      } catch (err) {
        if (cancelled) return;
        if (err.status === 404) {
          sessionStorage.removeItem(resumeKey(saleId));
          dispatch({ type: 'RESET' });
          return;
        }
        delay = reservationPollDelay(attempt++); // transient: keep trying, slower
      }
      timer = setTimeout(poll, withJitter(delay));
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.phase, state.trackingUrl, saleId]);

  return { state, submit, retryIn };
}
