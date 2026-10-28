import mongoose from 'mongoose';

// The durable source of truth for a sale's inventory.
// remainingStock is only ever changed with a conditional atomic update
// ({remainingStock: {$gt: 0}} + $inc), never read-modify-written in JS.
const flashSaleSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    totalStock: { type: Number, required: true, min: 1, validate: Number.isInteger },
    remainingStock: { type: Number, required: true, min: 0, validate: Number.isInteger },
    soldCount: { type: Number, default: 0, min: 0 },
    // Snapshot of the price at sale creation, so editing the product later
    // doesn't change what buyers of this sale pay.
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { timestamps: true },
);

flashSaleSchema.index({ endsAt: 1, startsAt: 1 });

flashSaleSchema.pre('validate', function checkWindow(next) {
  if (this.endsAt && this.startsAt && this.endsAt <= this.startsAt) {
    this.invalidate('endsAt', 'endsAt must be after startsAt');
  }
  if (this.remainingStock > this.totalStock) {
    this.invalidate('remainingStock', 'remainingStock cannot exceed totalStock');
  }
  next();
});

export const FlashSale = mongoose.model('FlashSale', flashSaleSchema);
