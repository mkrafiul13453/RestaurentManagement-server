import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createCategoryService, createMenuItemService } from "../services/catalog-service.js";
import { createImageUploadService, isImgBbUrl } from "../services/image-upload-service.js";
import { AppError } from "../utils/app-error.js";
import multer from "multer";

const maxImageSize = 5 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageSize, files: 1 },
  fileFilter(_request, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new AppError("Only JPEG, PNG, WebP, or AVIF images are allowed", 400, "INVALID_IMAGE_TYPE"));
      return;
    }
    callback(null, true);
  },
});

const idSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "ID must be a valid MongoDB ID"),
});
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const categoryFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
};
const categorySchema = z.object(categoryFields).strict();
const menuFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  imageUrl: z.string().trim().max(2048).refine((value) => value === "" || isImgBbUrl(value)).optional(),
  categoryId: z.string().regex(/^[\da-f]{24}$/i),
  priceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const menuItemSchema = z.object(menuFields).strict();
const updateMenuItemSchema = z.object({
  ...menuFields,
  isAvailable: z.boolean(),
}).strict();
const menuQuerySchema = pageSchema.extend({
  search: z.string().trim().max(120).optional(),
  categoryId: z.string().regex(/^[\da-f]{24}$/i).optional(),
}).strict();

function respond(response, data, message, status = 200, meta) {
  response.status(status).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
    message,
    error: null,
  });
}

export function createCategoriesRouter({ auth, Category, MenuItem }) {
  const router = Router();
  const service = createCategoryService({ Category, MenuItem });
  router.use(requireAuth(auth));

  router.get("/", requireRole("admin", "manager"), validate(pageSchema, "query"), async (request, response) => {
    const result = await service.list(request.validated.query);
    respond(response, { categories: result.categories }, "Categories retrieved", 200, result.meta);
  });
  router.post("/", requireRole("admin", "manager"), validate(categorySchema), async (request, response) => {
    respond(response, { category: await service.create(request.validated.body) }, "Category created", 201);
  });
  router.patch(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    validate(categorySchema),
    async (request, response) => {
      const category = await service.update(request.validated.params.id, request.validated.body);
      respond(response, { category }, "Category updated");
    },
  );
  router.delete(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    async (request, response) => {
      await service.remove(request.validated.params.id);
      response.status(204).end();
    },
  );
  return router;
}

export function createMenuItemsRouter({
  auth,
  Category,
  MenuItem,
  imgbbApiKey = "",
  imageUploadFetch = fetch,
}) {
  const router = Router();
  const service = createMenuItemService({ Category, MenuItem });
  const imageService = createImageUploadService({ apiKey: imgbbApiKey, fetchImpl: imageUploadFetch });
  router.use(requireAuth(auth));

  router.get("/", validate(menuQuerySchema, "query"), async (request, response) => {
    const result = await service.list(request.validated.query);
    respond(response, { menuItems: result.menuItems }, "Menu items retrieved", 200, result.meta);
  });
  router.post(
    "/images",
    requireRole("admin", "manager"),
    imageUpload.single("image"),
    async (request, response) => {
      const imageUrl = await imageService.upload(request.file);
      respond(response, { imageUrl }, "Menu item image uploaded", 201);
    },
  );
  router.post(
    "/",
    requireRole("admin", "manager"),
    validate(menuItemSchema),
    async (request, response) => {
      const menuItem = await service.create(request.validated.body);
      respond(response, { menuItem }, "Menu item created", 201);
    },
  );
  router.patch(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    validate(updateMenuItemSchema),
    async (request, response) => {
      const menuItem = await service.update(
        request.validated.params.id,
        request.validated.body,
      );
      respond(response, { menuItem }, "Menu item updated");
    },
  );
  router.delete(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    async (request, response) => {
      const menuItem = await service.archive(request.validated.params.id);
      respond(response, { menuItem }, "Menu item archived");
    },
  );
  return router;
}
