import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createTableService, TABLE_STATUSES } from "../services/table-service.js";
import { AppError } from "../utils/app-error.js";

const tableIdSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "Table ID must be a valid ID"),
});
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(TABLE_STATUSES).optional(),
  search: z.string().trim().max(50).optional(),
}).strict();
const createTableSchema = z.object({
  label: z.string().trim().min(1).max(50),
  capacity: z.coerce.number().int().min(1).max(1000),
}).strict();
const updateTableSchema = createTableSchema;
const updateStatusSchema = z.object({
  status: z.enum(TABLE_STATUSES),
  expectedStatus: z.enum(TABLE_STATUSES),
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

export function createTablesRouter({ auth, Table, Reservation, runInTransaction }) {
  const router = Router();
  const service = createTableService(Table, Reservation, runInTransaction);
  const authenticate = requireAuth(auth);
  const allowTableStaff = requireRole("admin", "manager", "waiter");
  const allowTableManagers = requireRole("admin", "manager");

  router.use(authenticate, allowTableStaff);

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const result = await service.list(request.validated.query);
    respond(response, { tables: result.tables }, "Tables retrieved", 200, result.meta);
  });

  router.post(
    "/",
    allowTableManagers,
    validate(createTableSchema),
    async (request, response) => {
      const table = await service.create(request.validated.body);
      respond(response, { table }, "Table created", 201);
    },
  );

  router.get(
    "/:id",
    validate(tableIdSchema, "params"),
    async (request, response) => {
      const table = await service.getById(request.validated.params.id);
      respond(response, { table }, "Table retrieved");
    },
  );

  router.patch(
    "/:id/status",
    validate(tableIdSchema, "params"),
    validate(updateStatusSchema),
    async (request, response) => {
      const table = await service.updateStatus(
        request.validated.params.id,
        request.validated.body,
      );
      respond(response, { table }, "Table status updated");
    },
  );

  router.patch(
    "/:id",
    allowTableManagers,
    validate(tableIdSchema, "params"),
    validate(updateTableSchema),
    async (request, response) => {
      const table = await service.update(
        request.validated.params.id,
        request.validated.body,
      );
      respond(response, { table }, "Table updated");
    },
  );

  router.delete(
    "/:id",
    allowTableManagers,
    validate(tableIdSchema, "params"),
    async (request, response) => {
      await service.remove(request.validated.params.id);
      response.status(204).end();
    },
  );

  return router;
}
