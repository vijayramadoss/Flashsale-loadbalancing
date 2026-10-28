import mongoose from 'mongoose';

export const ORDER_STATUS = ['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED', 'EXPIRED'];
// Statuses that still "own" stock (count as sold / held).
export const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];
// Statuses in which a unit counts as taken from a deal's allocation (a returned unit was still sold by the deal).
export const DEAL_SOLD_STATUSES = [...ACTIVE_STATUSES, 'RETURNED'];

// Line items and the address are SNAPSHOTS: later edits to the product or the
// user's address book must never change what an order says was bought / where it ships.
const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    slug: String,
    sku: { type: String, required: true },
    brand: String,
    name: { type: String, required: true },
    variantLabel: String,
    colorHex: String,
    design: String,
    qty: { type: Number, required: true, min: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    mrpCents: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const addressSnapshot = new mongoose.Schema(
  { fullName: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String, label: String },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['CART', 'DEAL'], required: true },
    deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
    // Flash-deal orders only: the id handed out at admission (202 Accepted).
    // Unique so a queue message delivered twice can never create two orders.
    reservationId: { type: String },
    // "<dealId>:<userId>" while the order is active; removed on cancel/expiry.
    // A unique index on it is the database backstop for one-per-customer.
    activeDealKey: { type: String },
    items: { type: [itemSchema], validate: (v) => v.length > 0 },
    pricing: {
      subtotalCents: { type: Number, required: true },
      savingsCents: { type: Number, default: 0 },
      couponDiscountCents: { type: Number, default: 0 },
      deliveryCents: { type: Number, default: 0 },
      totalCents: { type: Number, required: true },
    },
    coupon: { id: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' }, code: String },
    shippingAddress: addressSnapshot,
    delivery: {
      method: { type: String, enum: ['STANDARD', 'EXPRESS'], default: 'STANDARD' },
      etaFrom: Date,
      etaTo: Date,
    },
    payment: {
      method: { type: String, enum: ['UPI', 'CARD', 'COD'] },
      // PENDING → PROCESSING (at the gateway) → PAID; FAILED attempts can be retried; PAID → REFUND_PENDING → REFUNDED.
      status: { type: String, enum: ['PENDING', 'PROCESSING', 'PAID', 'COD', 'REFUND_PENDING', 'REFUNDED'], default: 'PENDING' },
      paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
      transactionId: String,
      cardBrand: String,
      last4: String, // the only card data ever stored
      vpa: String, // masked UPI id
      paidAt: Date,
      idempotencyKey: String,
      failedAttempts: { type: Number, default: 0 },
      lastError: String,
    },
    status: { type: String, enum: ORDER_STATUS, default: 'PENDING_PAYMENT' },
    deliveredAt: Date,
    // Return request on a delivered order (window: RETURN_WINDOW_DAYS).
    returnRequest: {
      status: { type: String, enum: ['REQUESTED', 'APPROVED', 'REJECTED'] },
      reason: String,
      requestedAt: Date,
      decidedAt: Date,
      note: String,
    },
    // Assigned once, when the order is confirmed (sequential, gap-free).
    invoice: { number: String, issuedAt: Date },
    // Unpaid orders hold stock only until this moment (the worker's sweeper releases it).
    expiresAt: { type: Date },
    history: [{ _id: false, status: String, at: { type: Date, default: Date.now }, note: String }],
  },
  { timestamps: true },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ reservationId: 1 }, { unique: true, sparse: true });
orderSchema.index({ activeDealKey: 1 }, { unique: true, sparse: true });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, expiresAt: 1 }); // sweeper query
orderSchema.index({ deal: 1, status: 1 });
orderSchema.index({ status: 1, createdAt: -1 }); // admin list

export const Order = mongoose.model('Order', orderSchema);
