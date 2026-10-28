import { useEffect, useState } from 'react';
import { formatCountdown, formatMinSec } from '../lib/format.js';

// Ticks locally (no network) against the SERVER clock (offset-corrected), so
// every buyer's button unlocks at the same real moment regardless of their
// own device clock. Only this small component re-renders each tick.
export default function Countdown({ target, offset = 0, onZero, format = 'hms', className = 'countdown', label = 'Time remaining' }) {
  const [left, setLeft] = useState(() => target - (Date.now() + offset));

  useEffect(() => {
    let fired = false;
    const tick = () => {
      const ms = target - (Date.now() + offset);
      setLeft(ms);
      if (ms <= 0 && !fired) {
        fired = true;
        onZero?.();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [target, offset, onZero]);

  return (
    <span className={className} role="timer" aria-label={label}>
      {format === 'ms' ? formatMinSec(left) : formatCountdown(left)}
    </span>
  );
}
