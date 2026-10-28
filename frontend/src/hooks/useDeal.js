import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { checkoutReducer, initialCheckout } from '../lib/checkout.js';
import { clockOffset, reservationPollDelay, salePollDelay, withJitter } from '../lib/polling.js';

/**
 * Live deal status with adaptive polling and server-clock sync: rare polls
 * while the deal is far away, frequent around launch, none once it is final;
 * 4× slower in background tabs; ±20 % jitter so clients don't poll in lock-step.
 */
export function useDealStatus(dealId) {
  const [deal, setDeal] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0); // serverTime - clientTime (ms)

  useEffect(() => {
    if (!dealId) return undefined;
    let cancelled = false;
    let timer;
    const load = async () => {
      const sentAt = Date.now();
      try {
        const { data } = await api(`/deals/${dealId}`, { auth: false });
        if (cancelled) return;
        const off = clockOffset(data.deal.serverTime, sentAt, Date.now());
        setOffset(off);
        setDeal(data.deal);
        setError(null);
        const msUntilStart = Date.parse(data.deal.startsAt) - (Date.now() + off);
        const delay = salePollDelay({ state: data.deal.state, msUntilStart, hidden: document.hidden });
        if (delay !== null) timer = setTimeout(load, withJitter(delay));
      } catch (err) {
        if (cancelled) return;
        setError(err);
        timer = setTimeout(load, withJitter(5000));
      }
    };
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
  }, [dealId]);

  return { deal, error, offset };
}

/**
 * Flash-deal "Buy now": submit with a synchronous click lock, then poll the
 * reservation until the worker has created the pending order (→ checkout).
 */
export function useReserve(dealId) {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckout);
  // A ref, not state: React state updates are asynchronous, so two clicks in
  // the same frame would both see "idle". The ref flips synchronously on the
  // first click; the second returns immediately — no duplicate request.
  const inFlight = useRef(false);

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: 'SUBMIT' });
    try {
      const { data } = await api(`/deals/${dealId}/reserve`, { method: 'POST' });
      dispatch({ type: 'ACCEPTED', status: data.status, reservationId: data.reservationId, trackingUrl: data.trackingUrl, orderId: data.orderId });
    } catch (err) {
      dispatch({ type: 'REJECTED', code: err.code, message: err.message, retryAfter: err.retryAfter });
    } finally {
      inFlight.current = false;
    }
  }, [dealId]);

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

  // Poll the reservation until RESERVED or FAILED.
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
          return;
        }
        delay = reservationPollDelay(attempt++, retryAfter);
      } catch (err) {
        if (cancelled) return;
        if (err.status === 404) return dispatch({ type: 'RESET' });
        delay = reservationPollDelay(attempt++); // transient: keep trying, slower
      }
      timer = setTimeout(poll, withJitter(delay));
    };
    timer = setTimeout(poll, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.phase, state.trackingUrl]);

  return { state, submit, retryIn };
}
