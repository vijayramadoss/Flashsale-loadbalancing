import mongoose from 'mongoose';

// One attempt to pay an order through the gateway. An order can have several
// (e.g. a declined card, then UPI); at most one is PROCESSING at a time.
//
//   PROCESSING ──webhook payment.captured──▶ CAPTURED ──refund──▶ REFUND_PENDING ──webhook refund.processed──▶ REFUNDED
//        └──────webhook payment.failed────▶ FAILED
const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, default: 'simulator' },
    providerPaymentId: { type: String },
    method: { type: String, enum: ['UPI', 'CARD'], required: true },
    amountCents: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['PROCESSING', 'CAPTURED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'], default: 'PROCESSING' },
    // Client-supplied key: retrying the same request returns this payment instead of charging again.
    idempotencyKey: { type: String, required: true },
    cardBrand: String,
    last4: String,
    vpa: String,
    failureCode: String,
    failureMessage: String,
    refundedCents: { type: Number, default: 0 },
    capturedAt: Date,
    refundedAt: Date,
  },
  { timestamps: true },
);

paymentSchema.index({ order: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1, updatedAt: 1 }); // reconciliation job

export const Payment = mongoose.model('Payment', paymentSchema);
