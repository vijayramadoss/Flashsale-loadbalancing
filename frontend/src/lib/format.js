const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

/** "OnePlus" + "OnePlus 13" → "OnePlus 13"; "Apple" + "iPhone 16" → "Apple iPhone 16". */
export const productTitle = (brand, name) => (brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name);

export function formatPrice(cents) {
  return inr.format(cents / 100);
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

/** "02:41" for short holds (minutes:seconds). */
export function formatMinSec(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const formatDate = (d) => dateFmt.format(new Date(d));
export const formatDateTime = (d) => dateTimeFmt.format(new Date(d));
export const formatEta = (from, to) => `${formatDate(from)} – ${formatDate(to)}`;

export const ORDER_STATUS = {
  PENDING_PAYMENT: { label: 'Awaiting payment', badge: 'warning' },
  CONFIRMED: { label: 'Confirmed', badge: 'info' },
  SHIPPED: { label: 'Shipped', badge: 'info' },
  DELIVERED: { label: 'Delivered', badge: 'success' },
  RETURNED: { label: 'Returned', badge: 'neutral' },
  CANCELLED: { label: 'Cancelled', badge: 'neutral' },
  EXPIRED: { label: 'Expired', badge: 'neutral' },
};
