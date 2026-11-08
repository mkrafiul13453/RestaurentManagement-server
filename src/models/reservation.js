import mongoose from "mongoose";

export const RESERVATION_STATUSES = ["confirmed", "cancelled"];

const reservationSchema = new mongoose.Schema(
  {
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      required: true,
      index: true,
    },
    userId: { type: String, required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    partySize: { type: Number, required: true, min: 1, max: 1000, validate: Number.isInteger },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    status: {
      type: String,
      enum: RESERVATION_STATUSES,
      default: "confirmed",
      required: true,
      index: true,
    },
  },
  { timestamps: true, collection: "reservations", versionKey: false },
);

reservationSchema.index({ tableId: 1, status: 1, startsAt: 1, endsAt: 1 });
reservationSchema.index({ userId: 1, startsAt: -1 });

export const Reservation =
  mongoose.models.Reservation || mongoose.model("Reservation", reservationSchema);
