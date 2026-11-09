import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createReservationService } from "../services/reservation-service.js";

const idSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "Reservation ID must be a valid ID"),
});
const tableIdSchema = z.string().regex(/^[\da-f]{24}$/i, "Table ID must be a valid ID");
const reservationFields = {
  tableId: tableIdSchema,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  partySize: z.coerce.number().int().min(1).max(1000),
  notes: z.string().trim().max(500).optional(),
};
const reservationSchema = z.object(reservationFields).strict();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().refine(
    (value) => {
      if (!value) return true;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    "Date must be a valid calendar date",
  ),
  status: z.enum(["confirmed", "cancelled"]).optional(),
  tableId: tableIdSchema.optional(),
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

export function createReservationsRouter({
  auth,
  Reservation,
  Table,
  runInTransaction,
  notificationService,
}) {
  const router = Router();
  const service = createReservationService({
    Reservation,
    Table,
    runInTransaction,
    notificationService,
  });
  const roles = requireRole("admin", "manager", "waiter", "customer");
  router.use(requireAuth(auth), roles);

  router.get("/tables", async (_request, response) => {
    const tables = await service.availableTables();
    respond(response, { tables }, "Reservation tables retrieved");
  });

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const result = await service.list({
      ...request.validated.query,
      role: request.user.role.trim().toLowerCase(),
      userId: request.user.id,
    });
    respond(response, { reservations: result.reservations }, "Reservations retrieved", 200, result.meta);
  });

  router.post(
    "/",
    requireRole("manager", "waiter", "customer"),
    validate(reservationSchema),
    async (request, response) => {
      const reservation = await service.create(request.validated.body, {
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, { reservation }, "Reservation created", 201);
    },
  );

  router.get(
    "/:id",
    requireRole("manager", "waiter", "customer"),
    validate(idSchema, "params"),
    async (request, response) => {
      const reservation = await service.getById(request.validated.params.id, {
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, { reservation }, "Reservation retrieved");
    },
  );

  router.patch(
    "/:id",
    requireRole("manager", "waiter", "customer"),
    validate(idSchema, "params"),
    validate(reservationSchema),
    async (request, response) => {
      const reservation = await service.update(
        request.validated.params.id,
        request.validated.body,
        {
          role: request.user.role.trim().toLowerCase(),
          userId: request.user.id,
        },
      );
      respond(response, { reservation }, "Reservation updated");
    },
  );

  router.patch(
    "/:id/cancel",
    requireRole("manager", "waiter", "customer"),
    validate(idSchema, "params"),
    async (request, response) => {
      const reservation = await service.cancel(request.validated.params.id, {
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, { reservation }, "Reservation cancelled");
    },
  );

  return router;
}
