export function formatPrice(cents, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

/** 3725000 → "01:02:05"; values ≥ 1 day are shown as "2d 03:00:00". */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}
