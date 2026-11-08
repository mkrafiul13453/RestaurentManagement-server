import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createOrderService } from "../services/order-service.js";

const kitchenQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["confirmed", "preparing"]).optional(),
}).strict();

export function createKitchenRouter({ auth, Order }) {
  const router = Router();
  const service = createOrderService({ Order });
  router.use(requireAuth(auth), requireRole("chef"));

  router.get("/", validate(kitchenQuerySchema, "query"), async (request, response) => {
    const result = await service.listKitchen(request.validated.query);
    response.status(200).json({
      success: true,
      data: { orders: result.orders },
      meta: result.meta,
      message: "Kitchen queue retrieved",
      error: null,
    });
  });

  return router;
}
