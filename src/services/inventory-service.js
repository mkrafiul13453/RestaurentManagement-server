import mongoose from "mongoose";
import { AppError } from "../utils/app-error.js";

const maxQuantity = Number.MAX_SAFE_INTEGER;

async function defaultRunInTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function requireIngredient(ingredient) {
  if (!ingredient) throw new AppError("Ingredient not found", 404, "NOT_FOUND");
  return ingredient;
}

function pagination(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

function toPlain(record) {
  return typeof record.toObject === "function" ? record.toObject() : record;
}

function serializeIngredient(record) {
  const value = toPlain(record);
  return {
    _id: String(value._id),
    name: value.name,
    unit: value.unit,
    quantity: value.quantity,
    minimumStock: value.minimumStock,
    isActive: value.isActive,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function serializeAdjustment(record) {
  const value = toPlain(record);
  return {
    _id: String(value._id),
    ingredientId: String(value.ingredientId),
    delta: value.delta,
    unit: value.unit,
    quantityAfter: value.quantityAfter,
    reason: value.reason,
    actorId: value.actorId,
    createdAt: value.createdAt,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createInventoryService({
  Ingredient,
  InventoryAdjustment,
  runInTransaction = defaultRunInTransaction,
}) {
  async function list({ page, limit, search, lowStock }) {
    const filter = { isActive: true };
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
    if (lowStock) filter.$expr = { $lte: ["$quantity", "$minimumStock"] };

    const [total, ingredients] = await Promise.all([
      Ingredient.countDocuments(filter),
      Ingredient.find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    return {
      ingredients: ingredients.map(serializeIngredient),
      meta: pagination(page, limit, total),
    };
  }

  return {
    listIngredients: list,

    async getIngredient(id) {
      return serializeIngredient(requireIngredient(await Ingredient.findById(id).lean()));
    },

    async createIngredient({ name, unit, minimumStock }) {
      const ingredient = await Ingredient.create({
        name,
        unit,
        quantity: 0,
        minimumStock,
        adjustmentCount: 0,
        isActive: true,
      });
      return serializeIngredient(ingredient);
    },

    async updateIngredient(id, fields) {
      const current = requireIngredient(await Ingredient.findById(id).lean());
      if (!current.isActive) {
        throw new AppError("Archived ingredients cannot be edited", 409, "INGREDIENT_ARCHIVED");
      }

      const { unit, ...otherFields } = fields;
      const update = { ...otherFields };
      const unitChanged = unit !== undefined && unit !== current.unit;
      if (unitChanged) update.unit = unit;
      const filter = { _id: id, isActive: true };
      if (unitChanged) {
        filter.quantity = 0;
        filter.adjustmentCount = 0;
      }

      const ingredient = await Ingredient.findOneAndUpdate(
        filter,
        { $set: update },
        { new: true, runValidators: true },
      );
      if (ingredient) return serializeIngredient(ingredient);

      const existing = await Ingredient.findById(id).lean();
      requireIngredient(existing);
      if (!existing.isActive) {
        throw new AppError("Archived ingredients cannot be edited", 409, "INGREDIENT_ARCHIVED");
      }
      if (unitChanged) {
        throw new AppError(
          "The unit cannot change after inventory has been adjusted or stocked",
          409,
          "INGREDIENT_UNIT_LOCKED",
        );
      }
      throw new AppError("Ingredient could not be updated", 409, "INGREDIENT_UPDATE_CONFLICT");
    },

    async archiveIngredient(id) {
      const ingredient = await Ingredient.findOneAndUpdate(
        { _id: id, isActive: true, quantity: 0 },
        { $set: { isActive: false } },
        { new: true, runValidators: true },
      );
      if (ingredient) return;

      const existing = await Ingredient.findById(id).lean();
      requireIngredient(existing);
      if (!existing.isActive) return;
      throw new AppError(
        "Ingredients with stock cannot be archived; adjust stock to zero first",
        409,
        "INGREDIENT_HAS_STOCK",
      );
    },

    async listInventory({ page, limit, search, lowStock }) {
      return list({ page, limit, search, lowStock });
    },

    async getInventory(id) {
      return serializeIngredient(requireIngredient(await Ingredient.findById(id).lean()));
    },

    async listAdjustments(ingredientId, { page, limit }) {
      requireIngredient(await Ingredient.findById(ingredientId).lean());
      const filter = { ingredientId };
      const [total, adjustments] = await Promise.all([
        InventoryAdjustment.countDocuments(filter),
        InventoryAdjustment.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return {
        adjustments: adjustments.map(serializeAdjustment),
        meta: pagination(page, limit, total),
      };
    },

    async adjustInventory({ ingredientId, delta, reason, actorId }) {
      return runInTransaction(async (session) => {
        const quantityAfterExpression = { $add: ["$quantity", delta] };
        const ingredient = await Ingredient.findOneAndUpdate(
          {
            _id: ingredientId,
            isActive: true,
            $expr: {
              $and: [
                { $gte: [quantityAfterExpression, 0] },
                { $lte: [quantityAfterExpression, maxQuantity] },
              ],
            },
          },
          { $inc: { quantity: delta, adjustmentCount: 1 } },
          { new: true, runValidators: true, session },
        );

        if (!ingredient) {
          const exists = await Ingredient.exists({ _id: ingredientId });
          requireIngredient(exists);
          const existing = await Ingredient.findById(ingredientId).lean();
          if (!existing.isActive) {
            throw new AppError("Archived ingredients cannot be adjusted", 409, "INGREDIENT_ARCHIVED");
          }
          throw new AppError(
            "Adjustment would make stock negative or exceed the supported quantity",
            409,
            "INVALID_STOCK_ADJUSTMENT",
          );
        }

        const [adjustment] = await InventoryAdjustment.create(
          [{
            ingredientId,
            delta,
            unit: ingredient.unit,
            quantityAfter: ingredient.quantity,
            reason,
            actorId,
          }],
          { session },
        );
        return {
          ingredient: serializeIngredient(ingredient),
          adjustment: serializeAdjustment(adjustment),
        };
      });
    },
  };
}
