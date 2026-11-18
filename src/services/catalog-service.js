import { AppError } from "../utils/app-error.js";

export function createCategoryService({ Category, MenuItem }) {
  return {
    async list({ page, limit }) {
      const filter = {};
      const [total, categories] = await Promise.all([
        Category.countDocuments(filter),
        Category.find(filter)
          .sort({ name: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return { categories, meta: pagination(page, limit, total) };
    },
    async create(fields) {
      return Category.create({ name: fields.name, description: fields.description ?? "" });
    },
    async update(id, fields) {
      const category = await Category.findByIdAndUpdate(
        id,
        { $set: { name: fields.name, description: fields.description ?? "" } },
        { new: true, runValidators: true },
      );
      if (!category) throw new AppError("Category not found", 404, "NOT_FOUND");
      return category;
    },
    async remove(id) {
      const category = await Category.findById(id).lean();
      if (!category) throw new AppError("Category not found", 404, "NOT_FOUND");
      if (await MenuItem.exists({ categoryId: id })) {
        throw new AppError("Category is still referenced by menu items", 409, "CATEGORY_IN_USE");
      }
      await Category.deleteOne({ _id: id });
    },
  };
}

export function createMenuItemService({ Category, MenuItem, Ingredient }) {
  async function validateRecipe(recipe = []) {
    const ingredientIds = recipe.map(({ ingredientId }) => ingredientId);
    if (new Set(ingredientIds).size !== ingredientIds.length) {
      throw new AppError("Each ingredient may appear only once in a recipe", 400, "DUPLICATE_RECIPE_INGREDIENT");
    }
    if (!recipe.length) return;
    if (!Ingredient) {
      throw new AppError("Inventory is not configured for recipes", 503, "INVENTORY_NOT_CONFIGURED");
    }
    const count = await Ingredient.countDocuments({
      _id: { $in: ingredientIds },
      isActive: true,
    });
    if (count !== ingredientIds.length) {
      throw new AppError("One or more recipe ingredients are missing or inactive", 400, "INVALID_RECIPE_INGREDIENT");
    }
  }

  return {
    async list({ page, limit, search, categoryId }) {
      const filter = { isAvailable: true };
      if (categoryId) filter.categoryId = categoryId;
      if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
      const [total, menuItems] = await Promise.all([
        MenuItem.countDocuments(filter),
        MenuItem.find(filter)
          .sort({ name: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return { menuItems, meta: pagination(page, limit, total) };
    },
    async create(fields) {
      if (!(await Category.exists({ _id: fields.categoryId }))) {
        throw new AppError("Category not found", 400, "INVALID_CATEGORY");
      }
      await validateRecipe(fields.recipe);
      return MenuItem.create({
        name: fields.name,
        description: fields.description ?? "",
        imageUrl: fields.imageUrl ?? "",
        categoryId: fields.categoryId,
        priceMinor: fields.priceMinor,
        recipe: fields.recipe ?? [],
        isAvailable: true,
      });
    },
    async update(id, fields) {
      if (!(await Category.exists({ _id: fields.categoryId }))) {
        throw new AppError("Category not found", 400, "INVALID_CATEGORY");
      }
      if (fields.recipe !== undefined) await validateRecipe(fields.recipe);
      const menuItem = await MenuItem.findByIdAndUpdate(
        id,
        {
          $set: {
            name: fields.name,
            description: fields.description ?? "",
            categoryId: fields.categoryId,
            priceMinor: fields.priceMinor,
            isAvailable: fields.isAvailable,
            ...(fields.recipe !== undefined ? { recipe: fields.recipe } : {}),
            ...(fields.imageUrl !== undefined ? { imageUrl: fields.imageUrl } : {}),
          },
        },
        { new: true, runValidators: true },
      );
      if (!menuItem) throw new AppError("Menu item not found", 404, "NOT_FOUND");
      return menuItem;
    },
    async archive(id) {
      const menuItem = await MenuItem.findByIdAndUpdate(
        id,
        { $set: { isAvailable: false } },
        { new: true },
      );
      if (!menuItem) throw new AppError("Menu item not found", 404, "NOT_FOUND");
      return menuItem;
    },
  };
}

function pagination(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
