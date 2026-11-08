import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createInventoryService } from "../services/inventory-service.js";

const idSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "ID must be a valid MongoDB ID"),
});
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const ingredientQuerySchema = pageSchema.extend({
  search: z.string().trim().max(120).optional(),
}).strict();
const inventoryQuerySchema = ingredientQuerySchema.extend({
  lowStock: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
}).strict();
const createIngredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(32),
  minimumStock: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();
const updateIngredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(32),
  minimumStock: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const adjustmentQuerySchema = pageSchema;
const adjustmentSchema = z.object({
  delta: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
    .refine((value) => value !== 0, "Adjustment must not be zero"),
  reason: z.string().trim().min(1).max(500),
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

export function createIngredientsRouter({
  auth,
  Ingredient,
  InventoryAdjustment,
  runInTransaction,
}) {
  const router = Router();
  const service = createInventoryService({ Ingredient, InventoryAdjustment, runInTransaction });

  router.use(requireAuth(auth));
  router.get(
    "/",
    requireRole("admin", "manager", "chef"),
    validate(ingredientQuerySchema, "query"),
    async (request, response) => {
      const result = await service.listIngredients(request.validated.query);
      respond(response, { ingredients: result.ingredients }, "Ingredients retrieved", 200, result.meta);
    },
  );
  router.post(
    "/",
    requireRole("admin", "manager"),
    validate(createIngredientSchema),
    async (request, response) => {
      const ingredient = await service.createIngredient(request.validated.body);
      respond(response, { ingredient }, "Ingredient created", 201);
    },
  );
  router.get(
    "/:id",
    requireRole("admin", "manager", "chef"),
    validate(idSchema, "params"),
    async (request, response) => {
      const ingredient = await service.getIngredient(request.validated.params.id);
      respond(response, { ingredient }, "Ingredient retrieved");
    },
  );
  router.patch(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    validate(updateIngredientSchema),
    async (request, response) => {
      const ingredient = await service.updateIngredient(
        request.validated.params.id,
        request.validated.body,
      );
      respond(response, { ingredient }, "Ingredient updated");
    },
  );
  router.delete(
    "/:id",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    async (request, response) => {
      await service.archiveIngredient(request.validated.params.id);
      response.status(204).end();
    },
  );

  return router;
}

export function createInventoryRouter({
  auth,
  Ingredient,
  InventoryAdjustment,
  runInTransaction,
}) {
  const router = Router();
  const service = createInventoryService({ Ingredient, InventoryAdjustment, runInTransaction });

  router.use(requireAuth(auth), requireRole("admin", "manager", "chef"));
  router.get("/", validate(inventoryQuerySchema, "query"), async (request, response) => {
    const result = await service.listInventory(request.validated.query);
    respond(response, { inventory: result.ingredients }, "Inventory retrieved", 200, result.meta);
  });
  router.get(
    "/:id",
    validate(idSchema, "params"),
    async (request, response) => {
      const inventory = await service.getInventory(request.validated.params.id);
      respond(response, { inventory }, "Inventory retrieved");
    },
  );
  router.get(
    "/:id/adjustments",
    validate(idSchema, "params"),
    validate(adjustmentQuerySchema, "query"),
    async (request, response) => {
      const result = await service.listAdjustments(
        request.validated.params.id,
        request.validated.query,
      );
      respond(response, { adjustments: result.adjustments }, "Inventory adjustments retrieved", 200, result.meta);
    },
  );
  router.post(
    "/:id/adjustments",
    requireRole("admin", "manager"),
    validate(idSchema, "params"),
    validate(adjustmentSchema),
    async (request, response) => {
      const result = await service.adjustInventory({
        ingredientId: request.validated.params.id,
        ...request.validated.body,
        actorId: request.user.id,
      });
      respond(response, result, "Inventory adjusted", 201);
    },
  );

  return router;
}
