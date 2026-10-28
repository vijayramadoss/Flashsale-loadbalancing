// SIMULATED payment gateway (no real money, no external calls). It behaves
// like a real one from the app's point of view: validates the instrument,
// approves or declines, and returns a transaction id. Card numbers and CVCs
// are never stored or logged — only the brand and last 4 digits.
//
// Test instruments (documented in CLAUDE.md):
//   Card 4242 4242 4242 4242 (any future expiry, any CVC) → approved
//   Card 4000 0000 0000 0002 → declined (card_declined)
//   Card 4000 0000 0000 9995 → declined (insufficient_funds)
//   UPI  anything@bank        → approved;  fail@<bank> → declined
import { randomBytes } from 'node:crypto';

const txnId = () => `pay_${randomBytes(9).toString('base64url')}`;

export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardBrand(n) {
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
  if (/^(60|65|81|82|508)/.test(n)) return 'RuPay';
  if (/^3[47]/.test(n)) return 'Amex';
  return 'Card';
}

const declined = (code, message) => ({ ok: false, code, message });

export function charge({ method, amountCents, card, upi }, now = new Date()) {
  if (method === 'CARD') {
    const number = String(card?.number || '').replace(/\D/g, '');
    if (number.length < 12 || number.length > 19 || !luhnValid(number)) return declined('INVALID_CARD', 'Card number is not valid');
    const [mm, yy] = String(card?.expiry || '').split('/').map((x) => Number(x));
    const expiryEnd = new Date(2000 + yy, mm, 1); // first day after the expiry month
    if (!(mm >= 1 && mm <= 12) || !(expiryEnd > now)) return declined('CARD_EXPIRED', 'Card has expired or the expiry date is invalid');
    if (!/^\d{3,4}$/.test(String(card?.cvc || ''))) return declined('INVALID_CVC', 'Security code is not valid');
    if (number === '4000000000000002') return declined('CARD_DECLINED', 'Your bank declined the payment');
    if (number === '4000000000009995') return declined('INSUFFICIENT_FUNDS', 'Insufficient funds on this card');
    return { ok: true, transactionId: txnId(), cardBrand: cardBrand(number), last4: number.slice(-4), amountCents };
  }
  if (method === 'UPI') {
    const vpa = String(upi?.vpa || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/.test(vpa)) return declined('INVALID_VPA', 'Enter a valid UPI ID (e.g. name@bank)');
    if (vpa.startsWith('fail@')) return declined('UPI_DECLINED', 'The UPI payment was declined in your app');
    const [user, bank] = vpa.split('@');
    return { ok: true, transactionId: txnId(), vpa: `${user.slice(0, 2)}***@${bank}`, amountCents };
  }
  return declined('UNSUPPORTED_METHOD', 'Unsupported payment method');
}
