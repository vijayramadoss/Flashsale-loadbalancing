// Flash-deal "Buy now" state machine. Every UI state the buyer can be in is
// explicit, which keeps the page responsive and honest under load:
//
//   idle ──click──▶ submitting ──202──▶ queued ──poll──▶ reserved (→ checkout page)
//                      │                   └──poll──▶ failed
//                      ├──409 SOLD_OUT──▶ soldOut
//                      ├──429/503/network──▶ retrying ──(timer)──▶ submitting
//                      └──other error──▶ error (user may retry)

export const MAX_AUTO_RETRIES = 3;

export const initialCheckout = {
  phase: 'idle',
  reservationId: null,
  trackingUrl: null,
  message: '',
  retryInSec: 0,
  attempts: 0,
  optimistic: false,
};

export function checkoutReducer(state, action) {
  switch (action.type) {
    case 'SUBMIT':
      // Optimistic UI: show "reserving" (and a -1 on the stock bar) immediately,
      // before the server has answered.
      // Automatic retries count up; a manual click starts a fresh retry budget.
      return {
        ...state,
        phase: 'submitting',
        message: '',
        optimistic: true,
        attempts: state.phase === 'retrying' ? state.attempts + 1 : 1,
      };

    case 'ACCEPTED':
      return {
        ...state,
        phase: action.status === 'RESERVED' ? 'reserved' : action.status === 'FAILED' ? 'failed' : 'queued',
        orderId: action.orderId,
        reservationId: action.reservationId,
        trackingUrl: action.trackingUrl,
        optimistic: true,
      };

    case 'STATUS':
      if (action.status === 'RESERVED') return { ...state, phase: 'reserved', orderId: action.orderId };
      if (action.status === 'FAILED') {
        return { ...state, phase: 'failed', optimistic: false, message: failureMessage(action.reason) };
      }
      return state;

    case 'REJECTED': {
      const { code, message, retryAfter } = action;
      if (code === 'SOLD_OUT') return { ...state, phase: 'soldOut', optimistic: false, message };
      // DEAL_NOT_STARTED is transient too: the local clock may flip the button a
      // few ms before the server's clock reaches the start time.
      const transient = ['RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT', 'DEAL_NOT_STARTED'].includes(code);
      if (transient && state.attempts <= MAX_AUTO_RETRIES) {
        return { ...state, phase: 'retrying', optimistic: false, message, retryInSec: Math.max(1, retryAfter || 2) };
      }
      return { ...state, phase: 'error', optimistic: false, message };
    }

    case 'RESET':
      return { ...initialCheckout };

    default:
      return state;
  }
}

function failureMessage(reason) {
  if (reason === 'SOLD_OUT') return 'The last units were claimed just before yours — sorry!';
  if (reason === 'ALREADY_PURCHASED') return 'You already have an order from this deal.';
  return 'We could not complete your order. Your slot was released — you can try again.';
}

/** The buy button may only be pressed from these phases. */
export const canSubmit = (phase) => phase === 'idle' || phase === 'error' || phase === 'failed';
