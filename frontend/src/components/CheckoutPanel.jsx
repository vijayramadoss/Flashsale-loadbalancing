import { useEffect } from 'react';
import { useAuth } from '../auth.jsx';
import { Link } from '../router.jsx';
import { useCheckout } from '../hooks.js';
import { canSubmit } from '../lib/checkout.js';

/**
 * The buy button and everything the buyer sees after pressing it.
 * `saleState` is the effective state (UPCOMING / LIVE / SOLD_OUT / ENDED).
 */
export default function CheckoutPanel({ saleId, saleState, onOptimistic }) {
  const { user } = useAuth();
  const { state, submit, retryIn } = useCheckout(saleId, user?.id);
  const { phase } = state;

  // Let the page show an optimistic "-1" on the stock bar while submitting.
  useEffect(() => {
    onOptimistic?.(phase === 'submitting');
  }, [phase, onOptimistic]);

  if (!user) {
    return (
      <div className="panel">
        <Link to="/login" className="btn btn-primary btn-block">Log in to buy</Link>
        <p className="muted small">One unit per customer. You need an account to take part.</p>
      </div>
    );
  }

  let label = 'Buy now';
  let disabled = !canSubmit(phase);
  if (saleState === 'UPCOMING') { label = 'Not started yet'; disabled = true; }
  if (saleState === 'ENDED' && phase === 'idle') { label = 'Sale ended'; disabled = true; }
  if (saleState === 'SOLD_OUT' && canSubmit(phase)) { label = 'Sold out'; disabled = true; }
  if (phase === 'submitting') label = 'Reserving…';
  if (phase === 'retrying') label = `High demand — retrying in ${retryIn}s`;
  if (phase === 'queued') label = 'In the queue…';
  if (phase === 'confirmed') label = 'Order confirmed ✓';
  if (phase === 'soldOut') label = 'Sold out';
  if (phase === 'error' || phase === 'failed') label = 'Try again';

  return (
    <div className="panel">
      <button
        type="button"
        className={`btn btn-primary btn-block${phase === 'confirmed' ? ' btn-success' : ''}`}
        disabled={disabled}
        aria-busy={phase === 'submitting' || phase === 'queued'}
        onClick={submit}
      >
        {(phase === 'submitting' || phase === 'queued') && <span className="spinner" aria-hidden="true" />}
        {label}
      </button>

      <div className="status" role="status" aria-live="polite">
        {phase === 'submitting' && <p>Securing your unit…</p>}
        {phase === 'queued' && (
          <p>
            <strong>You're in!</strong> Your unit is reserved and the order is being written. This usually takes a
            second — keep this page open.
          </p>
        )}
        {phase === 'confirmed' && (
          <p className="ok">
            Your order is confirmed. <Link to="/orders">View my orders</Link>
          </p>
        )}
        {phase === 'retrying' && <p className="warn">{state.message}</p>}
        {(phase === 'error' || phase === 'failed' || phase === 'soldOut') && state.message && (
          <p className={phase === 'soldOut' ? 'muted' : 'err'}>{state.message}</p>
        )}
      </div>
    </div>
  );
}
