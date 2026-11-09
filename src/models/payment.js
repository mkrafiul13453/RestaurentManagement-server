import mongoose from "mongoose";

export const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "cancelled",
  "refunded",
];

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    userId: { type: String, required: true, index: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    currency: { type: String, enum: ["usd"], default: "usd", required: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: "pending", required: true, index: true },
    stripeSessionId: { type: String, default: "" },
    stripePaymentIntentId: { type: String, default: "" },
    refundRequestedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "payments", versionKey: false },
);

paymentSchema.index(
  { orderId: 1 },
  {
    name: "pending_payment_per_order",
    unique: true,
    partialFilterExpression: { status: "pending" },
  },
);
paymentSchema.index(
  { stripeSessionId: 1 },
  { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string", $gt: "" } } },
);
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ orderId: 1, createdAt: -1 });
paymentSchema.index({ createdAt: 1, status: 1 });
paymentSchema.index({ stripePaymentIntentId: 1 });

export const Payment =
  mongoose.models.Payment || mongoose.model("Payment", paymentSchema);

const stripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
  },
  { timestamps: true, collection: "stripe_events", versionKey: false },
);

export const StripeEvent =
  mongoose.models.StripeEvent || mongoose.model("StripeEvent", stripeEventSchema);
