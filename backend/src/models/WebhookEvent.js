import mongoose from 'mongoose';

// Every gateway webhook we have processed. Gateways deliver "at least once"
// (they retry on timeouts), so the unique eventId makes processing idempotent:
// a redelivered event hits the index and is acknowledged without side effects.
const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    providerPaymentId: String,
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

webhookEventSchema.index({ eventId: 1 }, { unique: true });
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
