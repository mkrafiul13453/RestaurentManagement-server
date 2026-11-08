import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true, collection: "categories", versionKey: false },
);

categorySchema.index({ name: 1 }, { unique: true });

export const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);
