import mongoose from "mongoose";

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    unit: { type: String, required: true, trim: true, minlength: 1, maxlength: 32 },
    quantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isFinite,
    },
    minimumStock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isFinite,
    },
    adjustmentCount: { type: Number, required: true, default: 0, select: false },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "ingredients", versionKey: false },
);

ingredientSchema.index({ isActive: 1, name: 1 });

export const Ingredient =
  mongoose.models.Ingredient || mongoose.model("Ingredient", ingredientSchema);

const inventoryAdjustmentSchema = new mongoose.Schema(
  {
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      required: true,
    },
    delta: {
      type: Number,
      required: true,
      validate: (value) => Number.isFinite(value) && value !== 0,
    },
    unit: { type: String, required: true, trim: true, maxlength: 32 },
    quantityAfter: {
      type: Number,
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isFinite,
    },
    reason: { type: String, required: true, trim: true, minlength: 1, maxlength: 500 },
    actorId: { type: String, required: true },
  },
  { timestamps: true, collection: "inventory_adjustments", versionKey: false },
);

inventoryAdjustmentSchema.index({ ingredientId: 1, createdAt: -1, _id: -1 });

export const InventoryAdjustment =
  mongoose.models.InventoryAdjustment ||
  mongoose.model("InventoryAdjustment", inventoryAdjustmentSchema);
