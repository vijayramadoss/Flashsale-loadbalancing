import mongoose from 'mongoose';

// Product review. Only customers with a DELIVERED order containing the
// product may write one ("verified purchase"), one review per product.
const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true }, // snapshot: "Riya S."
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 100 },
    body: { type: String, trim: true, maxlength: 2000, default: '' },
    variantLabel: String,
  },
  { timestamps: true },
);

reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, createdAt: -1 });

export const Review = mongoose.model('Review', reviewSchema);
