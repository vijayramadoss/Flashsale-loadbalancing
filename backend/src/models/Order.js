import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema(
  {
    // The id handed to the client at admission time (202 Accepted). Unique so
    // a message redelivered from the queue can never create a second order.
    reservationId: { type: String, required: true },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashSale', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    quantity: { type: Number, default: 1, min: 1, max: 1 },
    priceCents: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['CONFIRMED'], default: 'CONFIRMED' },
  },
  { timestamps: true },
);

orderSchema.index({ reservationId: 1 }, { unique: true });
// Database-level backstop for the one-unit-per-user rule enforced in Redis.
orderSchema.index({ sale: 1, user: 1 }, { unique: true });
orderSchema.index({ user: 1, createdAt: -1 });

export const Order = mongoose.model('Order', orderSchema);
