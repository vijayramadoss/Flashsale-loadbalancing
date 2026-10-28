import mongoose from 'mongoose';

// Discount code for cart orders (not flash deals — those are already discounted).
// usedCount is only changed with a conditional atomic $inc (usedCount < usageLimit),
// so a limited coupon can never be redeemed more times than allowed, even under
// concurrent checkouts.
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{3,20}$/ },
    description: { type: String, trim: true, maxlength: 140, default: '' },
    type: { type: String, enum: ['PERCENT', 'FLAT'], required: true },
    value: { type: Number, required: true, min: 1 }, // percent (1-90) or paise
    maxDiscountCents: { type: Number, min: 0 }, // cap for PERCENT coupons
    minOrderCents: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    usageLimit: { type: Number, required: true, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

couponSchema.index({ code: 1 }, { unique: true });

couponSchema.pre('validate', function check(next) {
  if (this.type === 'PERCENT' && this.value > 90) this.invalidate('value', 'Percent coupons are limited to 90 %');
  if (this.validTo && this.validFrom && this.validTo <= this.validFrom) this.invalidate('validTo', 'validTo must be after validFrom');
  next();
});

// One redemption per customer per coupon (unique index = database-level guarantee).
const redemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  },
  { timestamps: true },
);
redemptionSchema.index({ coupon: 1, user: 1 }, { unique: true });

export const Coupon = mongoose.model('Coupon', couponSchema);
export const CouponRedemption = mongoose.model('CouponRedemption', redemptionSchema);
