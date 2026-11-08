import mongoose from "mongoose";

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    imageUrl: { type: String, trim: true, maxlength: 2048, default: "" },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },
    priceMinor: {
      type: Number,
      required: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      validate: { validator: Number.isSafeInteger, message: "Price must be an integer minor-unit amount" },
    },
    isAvailable: { type: Boolean, default: true, required: true, index: true },
  },
  { timestamps: true, collection: "menuItems", versionKey: false },
);

menuItemSchema.index({ categoryId: 1, name: 1 });
menuItemSchema.index({ isAvailable: 1, name: 1 });

export const MenuItem =
  mongoose.models.MenuItem || mongoose.model("MenuItem", menuItemSchema);
