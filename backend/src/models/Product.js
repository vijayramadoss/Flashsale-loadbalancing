import mongoose from 'mongoose';

// Catalog entry. Inventory for a flash sale lives on FlashSale, not here,
// so the same product can be sold in several sales with separate allocations.
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    imageUrl: { type: String, trim: true, maxlength: 500, default: '' },
    // Money is stored as an integer number of minor units (paise/cents) to
    // avoid floating-point rounding errors.
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, default: 'INR', maxlength: 3 },
  },
  { timestamps: true },
);

export const Product = mongoose.model('Product', productSchema);
