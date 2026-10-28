import { Coupon, CouponRedemption } from '../models/Coupon.js';
import { AppError, conflict } from '../lib/errors.js';

export function couponDiscount(coupon, subtotalCents) {
  if (!coupon) return 0;
  const raw = coupon.type === 'PERCENT' ? Math.round((subtotalCents * coupon.value) / 100) : coupon.value;
  const capped = coupon.type === 'PERCENT' && coupon.maxDiscountCents ? Math.min(raw, coupon.maxDiscountCents) : raw;
  return Math.max(0, Math.min(capped, subtotalCents));
}

const describe = (c) => (c.type === 'PERCENT' ? `${c.value}% off${c.maxDiscountCents ? ` (up to ₹${(c.maxDiscountCents / 100).toLocaleString('en-IN')})` : ''}` : `₹${(c.value / 100).toLocaleString('en-IN')} off`);

/** Why a coupon can't be used right now (null = usable). */
async function problem(c, subtotalCents, userId) {
  const now = new Date();
  if (!c || !c.active) return ['COUPON_NOT_FOUND', 'This coupon code is not valid'];
  if (now < c.validFrom) return ['COUPON_NOT_STARTED', 'This coupon is not active yet'];
  if (now >= c.validTo) return ['COUPON_EXPIRED', 'This coupon has expired'];
  if (c.usedCount >= c.usageLimit) return ['COUPON_USED_UP', 'This coupon has been fully redeemed'];
  if (subtotalCents < c.minOrderCents) return ['COUPON_MIN_ORDER', `Add items worth ₹${((c.minOrderCents - subtotalCents) / 100).toLocaleString('en-IN')} more to use this coupon`];
  if (userId && (await CouponRedemption.exists({ coupon: c._id, user: userId }))) return ['COUPON_ALREADY_USED', 'You have already used this coupon'];
  return null;
}

/** Cart preview: returns {code, discountCents, description} or {code, error} — never throws for coupon problems. */
export async function previewCoupon(code, subtotalCents, userId) {
  const c = await Coupon.findOne({ code: String(code).trim().toUpperCase() }).lean();
  const p = await problem(c, subtotalCents, userId);
  if (p) return { code: String(code).toUpperCase(), error: { code: p[0], message: p[1] } };
  return { code: c.code, discountCents: couponDiscount(c, subtotalCents), description: describe(c) };
}

/**
 * Redeems a coupon inside the order transaction. The usage counter is taken
 * with a conditional atomic $inc (usedCount < usageLimit), and the unique
 * (coupon, user) redemption row enforces one use per customer — so neither the
 * global limit nor the per-customer limit can be exceeded by concurrent orders.
 */
export async function redeemCoupon({ code, userId, orderId, subtotalCents }, session) {
  const now = new Date();
  const c = await Coupon.findOneAndUpdate(
    {
      code: String(code).trim().toUpperCase(),
      active: true,
      validFrom: { $lte: now },
      validTo: { $gt: now },
      minOrderCents: { $lte: subtotalCents },
      $expr: { $lt: ['$usedCount', '$usageLimit'] },
    },
    { $inc: { usedCount: 1 } },
    { new: true, session },
  );
  if (!c) {
    const existing = await Coupon.findOne({ code: String(code).trim().toUpperCase() }).session(session).lean();
    const [errCode, message] = (await problem(existing, subtotalCents)) || ['COUPON_UNAVAILABLE', 'This coupon cannot be used'];
    throw conflict(errCode, message);
  }
  try {
    await CouponRedemption.create([{ coupon: c._id, user: userId, order: orderId }], { session });
  } catch (err) {
    if (err.code === 11000) throw conflict('COUPON_ALREADY_USED', 'You have already used this coupon');
    throw err;
  }
  return { id: c._id, code: c.code, discountCents: couponDiscount(c, subtotalCents) };
}

/** Gives a coupon use back when its order is cancelled or expires (inside that transaction). */
export async function releaseCoupon(order, session) {
  if (!order.coupon?.id) return;
  const removed = await CouponRedemption.deleteOne({ coupon: order.coupon.id, user: order.user, order: order._id }, { session });
  if (removed.deletedCount) await Coupon.updateOne({ _id: order.coupon.id, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
}

// ---------- admin ----------
export async function createCoupon(data) {
  if (await Coupon.exists({ code: data.code.toUpperCase() })) throw new AppError(409, 'DUPLICATE', 'A coupon with this code already exists');
  return Coupon.create(data);
}

export async function listCoupons() {
  return Coupon.find().sort({ createdAt: -1 }).limit(100).lean();
}

export async function setCouponActive(id, active) {
  const c = await Coupon.findByIdAndUpdate(id, { $set: { active } }, { new: true }).lean();
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Coupon not found');
  return c;
}
