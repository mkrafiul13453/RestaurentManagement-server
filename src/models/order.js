import mongoose from "mongoose";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "completed",
  "cancelled",
];

const orderLineSchema = new mongoose.Schema(
  {
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuItem",
      required: true,
    },
    nameSnapshot: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 99,
      validate: Number.isSafeInteger,
    },
    unitPriceMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    lineTotalMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    lines: { type: [orderLineSchema], required: true, validate: [(lines) => lines.length > 0, "An order must contain at least one line"] },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded"],
      default: "unpaid",
      required: true,
      index: true,
    },
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", default: null },
    subtotalMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    taxRateBasisPoints: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
      validate: Number.isSafeInteger,
    },
    taxRoundingPolicy: { type: String, enum: ["half_up"], required: true },
    taxMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    discountMinor: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    totalMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  },
  { timestamps: true, collection: "orders", versionKey: false },
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ createdAt: 1, status: 1 });
orderSchema.index({ table: 1, status: 1 });

export const Order =
  mongoose.models.Order || mongoose.model("Order", orderSchema);
