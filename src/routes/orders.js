import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createOrderService } from "../services/order-service.js";
import { ORDER_STATUSES } from "../models/order.js";

const orderIdSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "Order ID must be a valid MongoDB ID"),
});
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ORDER_STATUSES).optional(),
}).strict();
const createOrderSchema = z.object({
  items: z.array(z.object({
    menuItemId: z.string().regex(/^[\da-f]{24}$/i),
    quantity: z.number().int().min(1).max(99),
  }).strict()).min(1).max(50).refine(
    (items) => new Set(items.map((item) => item.menuItemId)).size === items.length,
    "Each menu item may appear once; use quantity for multiples",
  ),
  tableId: z.string().regex(/^[\da-f]{24}$/i).optional(),
}).strict();
const statusSchema = z.object({
  expectedStatus: z.enum(ORDER_STATUSES),
  status: z.enum(ORDER_STATUSES),
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

export function createOrdersRouter({
  auth,
  Order,
  MenuItem,
  Table,
  taxRateBasisPoints,
  taxRoundingPolicy,
  runInTransaction,
  Payment,
  publishOrderUpdate = () => {},
}) {
  const router = Router();
  const service = createOrderService({
    Order,
    MenuItem,
    Table,
    taxRateBasisPoints,
    taxRoundingPolicy,
    runInTransaction,
    Payment,
  });
  const authenticate = requireAuth(auth);
  const orderRoles = ["admin", "manager", "waiter", "chef", "cashier", "customer"];

  router.use(authenticate, requireRole(...orderRoles));
  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const result = await service.list({
      ...request.validated.query,
      role: request.user.role.trim().toLowerCase(),
      userId: request.user.id,
    });
    respond(response, { orders: result.orders }, "Orders retrieved", 200, result.meta);
  });

  router.post(
    "/",
    requireRole("admin", "manager", "waiter", "customer"),
    validate(createOrderSchema),
    async (request, response) => {
      const order = await service.create({
        userId: request.user.id,
        items: request.validated.body.items,
        tableId: request.validated.body.tableId,
      });
      publishOrderUpdate(order);
      respond(response, { order }, "Order created", 201);
    },
  );

  router.get(
    "/:id",
    validate(orderIdSchema, "params"),
    async (request, response) => {
      const order = await service.getById(request.validated.params.id, {
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, { order }, "Order retrieved");
    },
  );

  router.patch(
    "/:id/status",
    validate(orderIdSchema, "params"),
    validate(statusSchema),
    async (request, response) => {
      const order = await service.updateStatus(
        request.validated.params.id,
        {
          ...request.validated.body,
          role: request.user.role.trim().toLowerCase(),
        },
      );
      publishOrderUpdate(order);
      respond(response, { order }, "Order status updated");
    },
  );

  return router;
}
