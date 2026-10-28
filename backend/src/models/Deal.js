import mongoose from 'mongoose';

// A flash deal: a fixed allocation of ONE variant sold at a special price in a
// time window, one unit per customer. Its stock is separate from the variant's
// regular stock. remainingStock is the durable source of truth and is only
// changed with conditional atomic updates ({remainingStock: {$gt: 0}} + $inc).
const dealSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    sku: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    totalStock: { type: Number, required: true, min: 1, validate: Number.isInteger },
    remainingStock: { type: Number, required: true, min: 0, validate: Number.isInteger },
    soldCount: { type: Number, default: 0, min: 0 },
    dealPriceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    mrpCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    // How long a winner has to complete checkout before the unit goes back on sale.
    holdMinutes: { type: Number, default: 10, min: 1, max: 60 },
  },
  { timestamps: true },
);

dealSchema.index({ endsAt: 1, startsAt: 1 });
dealSchema.index({ product: 1, endsAt: 1 });

dealSchema.pre('validate', function checkWindow(next) {
  if (this.endsAt && this.startsAt && this.endsAt <= this.startsAt) this.invalidate('endsAt', 'endsAt must be after startsAt');
  if (this.remainingStock > this.totalStock) this.invalidate('remainingStock', 'remainingStock cannot exceed totalStock');
  next();
});

export const Deal = mongoose.model('Deal', dealSchema);
