import mongoose from 'mongoose';

// A purchasable configuration of a phone (colour × storage). Stock is kept per
// variant and only ever changed with conditional atomic updates such as
//   updateOne({'variants': {$elemMatch: {sku, stock: {$gte: qty}}}}, {$inc: {'variants.$.stock': -qty}})
const variantSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, required: true, trim: true, maxlength: 40 },
    colorHex: { type: String, required: true, match: /^#[0-9a-f]{6}$/i },
    storage: { type: String, required: true, maxlength: 20 }, // e.g. "256 GB"
    ram: { type: String, required: true, maxlength: 20 },
    // Money in integer minor units (paise) — never floating point.
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    mrpCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    stock: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, trim: true, lowercase: true, match: /^[a-z0-9-]+$/ },
    brand: { type: String, required: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    tagline: { type: String, trim: true, maxlength: 160, default: '' },
    description: { type: String, trim: true, maxlength: 4000, default: '' },
    highlights: { type: [String], default: [] },
    specs: {
      display: String,
      processor: String,
      rearCamera: String,
      frontCamera: String,
      battery: String,
      charging: String,
      os: String,
      weight: String,
      network: String,
    },
    // Hint for the illustrated product image (no copyrighted photos are used).
    design: { type: String, enum: ['square', 'bar', 'vertical', 'circle', 'pill'], default: 'square' },
    variants: { type: [variantSchema], validate: (v) => v.length > 0 },
    // Denormalised for fast listing filters/sorts; maintained by the pre-validate hook.
    minPriceCents: { type: Number, min: 0 },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    ratingCount: { type: Number, min: 0, default: 0 },
    // Sum of all star ratings: lets a new review update the average with one atomic $inc.
    ratingSum: { type: Number, min: 0 },
    releaseYear: { type: Number },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ 'variants.sku': 1 }, { unique: true });
productSchema.index({ active: 1, brand: 1, minPriceCents: 1 });
productSchema.index({ name: 'text', brand: 'text', tagline: 'text' }, { weights: { name: 5, brand: 3, tagline: 1 } });

productSchema.pre('validate', function denormalise(next) {
  if (this.variants?.length) this.minPriceCents = Math.min(...this.variants.map((v) => v.priceCents));
  next();
});

export const variantLabel = (v) => `${v.ram} RAM · ${v.storage} · ${v.color}`;

export const Product = mongoose.model('Product', productSchema);
