import mongoose from 'mongoose';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { AppError, conflict, notFound } from '../lib/errors.js';

const shortName = (name) => {
  const [first, last] = name.trim().split(/\s+/);
  return last ? `${first} ${last[0]}.` : first;
};

/** The delivered order that makes this customer a verified buyer of the product (or null). */
async function deliveredOrderFor(productId, userId) {
  return Order.findOne({ user: userId, status: { $in: ['DELIVERED', 'RETURNED'] }, 'items.product': productId }, { items: 1 }).lean();
}

export async function listReviews(slug, { page = 1, limit = 10, userId } = {}) {
  const product = await Product.findOne({ slug, active: true }, { _id: 1, rating: 1, ratingCount: 1 }).lean();
  if (!product) throw notFound('Product not found');
  const [reviews, total, histogram] = await Promise.all([
    Review.find({ product: product._id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Review.countDocuments({ product: product._id }),
    Review.aggregate([{ $match: { product: product._id } }, { $group: { _id: '$rating', n: { $sum: 1 } } }]),
  ]);
  let canReview = false;
  let reason = 'SIGN_IN';
  if (userId) {
    if (await Review.exists({ product: product._id, user: userId })) reason = 'ALREADY_REVIEWED';
    else if (await deliveredOrderFor(product._id, userId)) {
      canReview = true;
      reason = null;
    } else reason = 'NOT_PURCHASED';
  }
  return {
    rating: product.rating,
    ratingCount: product.ratingCount,
    histogram: Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, histogram.find((h) => h._id === s)?.n || 0])),
    reviews: reviews.map((r) => ({
      id: r._id.toString(),
      authorName: r.authorName,
      rating: r.rating,
      title: r.title,
      body: r.body,
      variantLabel: r.variantLabel,
      verifiedPurchase: true,
      createdAt: r.createdAt,
    })),
    page,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    canReview,
    cannotReviewReason: reason,
  };
}

/**
 * Adds a verified-purchase review and updates the product's average in the same
 * transaction: ratingSum and ratingCount move together with one atomic $inc,
 * so concurrent reviews can't corrupt the average.
 */
export async function addReview(slug, userId, { rating, title, body = '' }) {
  const product = await Product.findOne({ slug, active: true });
  if (!product) throw notFound('Product not found');
  const order = await deliveredOrderFor(product._id, userId);
  if (!order) throw new AppError(403, 'NOT_PURCHASED', 'Only customers who received this phone can review it');
  const user = await User.findById(userId, { name: 1 }).lean();
  const item = order.items.find((i) => String(i.product) === String(product._id));

  const session = await mongoose.startSession();
  let review;
  try {
    await session.withTransaction(async () => {
      [review] = await Review.create(
        [{ product: product._id, user: userId, authorName: shortName(user.name), rating, title: title.trim(), body: body.trim(), variantLabel: item?.variantLabel }],
        { session },
      );
      // Products seeded without ratingSum: start the sum from the existing average.
      const base = product.ratingSum ?? Math.round((product.rating || 0) * (product.ratingCount || 0));
      // One pipeline update: add to sum and count, then recompute the 1-decimal average.
      await Product.updateOne(
        { _id: product._id },
        [
          { $set: { ratingSum: { $add: [{ $ifNull: ['$ratingSum', base] }, rating] }, ratingCount: { $add: ['$ratingCount', 1] } } },
          { $set: { rating: { $round: [{ $divide: ['$ratingSum', '$ratingCount'] }, 1] } } },
        ],
        { session },
      );
    });
  } catch (err) {
    if (err.code === 11000) throw conflict('ALREADY_REVIEWED', 'You have already reviewed this phone');
    throw err;
  } finally {
    await session.endSession();
  }
  return { id: review._id.toString(), rating: review.rating, title: review.title, body: review.body, authorName: review.authorName, createdAt: review.createdAt };
}
