import mongoose from "mongoose";

export const NOTIFICATION_TYPES = [
  "order_status_changed",
  "reservation_status_changed",
  "payment_status_changed",
];
const statusesByResource = {
  order: ["pending", "confirmed", "preparing", "ready", "completed", "cancelled"],
  reservation: ["confirmed", "cancelled"],
  payment: ["pending", "paid", "failed", "cancelled", "refunded"],
};

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: String, required: true },
    eventKey: { type: String, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    resourceType: { type: String, enum: ["order", "reservation", "payment"], required: true },
    resourceId: { type: String, required: true },
    previousStatus: { type: String, required: true },
    newStatus: { type: String, required: true },
    isRead: { type: Boolean, default: false, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "notifications", versionKey: false },
);

notificationSchema.pre("validate", function validateEvent() {
  const expectedType = {
    order: "order_status_changed",
    reservation: "reservation_status_changed",
    payment: "payment_status_changed",
  }[this.resourceType];
  if (this.type !== expectedType) {
    this.invalidate("type", "Notification type must match its resource type");
  }
  const allowedStatuses = statusesByResource[this.resourceType] ?? [];
  if (!allowedStatuses.includes(this.previousStatus)) {
    this.invalidate("previousStatus", "Invalid previous status for notification resource");
  }
  if (!allowedStatuses.includes(this.newStatus)) {
    this.invalidate("newStatus", "Invalid new status for notification resource");
  }
  if (this.previousStatus === this.newStatus) {
    this.invalidate("newStatus", "Notification statuses must be different");
  }
});

notificationSchema.index({ eventKey: 1, recipientId: 1 }, { unique: true });
notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

export const Notification =
  mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
