import mongoose from "mongoose";

const tableSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: 1000,
      validate: {
        validator: Number.isInteger,
        message: "Capacity must be a whole number",
      },
    },
    status: {
      type: String,
      enum: ["available", "occupied", "reserved"],
      default: "available",
      required: true,
    },
    activeOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    reservationRevision: { type: Number, default: 0, select: false },
  },
  {
    timestamps: true,
    collection: "tables",
    versionKey: false,
  },
);

tableSchema.index({ label: 1 }, { unique: true });
tableSchema.index({ status: 1, label: 1 });
tableSchema.index(
  { activeOrderId: 1 },
  { unique: true, partialFilterExpression: { activeOrderId: { $type: "objectId" } } },
);

export const Table =
  mongoose.models.Table || mongoose.model("Table", tableSchema);
