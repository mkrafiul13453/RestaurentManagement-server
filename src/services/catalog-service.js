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

export function createMenuItemService({ Category, MenuItem }) {
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
      return MenuItem.create({
        name: fields.name,
        description: fields.description ?? "",
        imageUrl: fields.imageUrl ?? "",
        categoryId: fields.categoryId,
        priceMinor: fields.priceMinor,
        isAvailable: true,
      });
    },
    async update(id, fields) {
      if (!(await Category.exists({ _id: fields.categoryId }))) {
        throw new AppError("Category not found", 400, "INVALID_CATEGORY");
      }
      const menuItem = await MenuItem.findByIdAndUpdate(
        id,
        {
          $set: {
            name: fields.name,
            description: fields.description ?? "",
            categoryId: fields.categoryId,
            priceMinor: fields.priceMinor,
            isAvailable: fields.isAvailable,
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
