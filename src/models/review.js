import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: Number.isInteger,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 1000,
      validate: {
        validator: (value) => /[\p{L}\p{N}]/u.test(value) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
        message: "Review text must contain readable text without control characters",
      },
    },
  },
  { timestamps: true, collection: "reviews", versionKey: false },
);

reviewSchema.index({ userId: 1, orderId: 1 }, { unique: true });
reviewSchema.index({ userId: 1, createdAt: -1 });

export const Review =
  mongoose.models.Review || mongoose.model("Review", reviewSchema);
