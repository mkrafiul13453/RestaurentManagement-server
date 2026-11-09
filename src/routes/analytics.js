import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createAnalyticsService } from "../services/analytics-service.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const querySchema = z.object({
  period: z.enum(["daily", "weekly", "monthly", "custom"]).default("daily"),
  date: z.string().regex(datePattern).optional(),
  from: z.string().regex(datePattern).optional(),
  to: z.string().regex(datePattern).optional(),
  timeZone: z.string().trim().min(1).max(64).default("UTC"),
}).strict();

export function createAnalyticsRouter({ auth, Order, Payment }) {
  const router = Router();
  const service = createAnalyticsService({ Order, Payment });
  router.use(requireAuth(auth), requireRole("admin", "manager"));
  router.get("/", validate(querySchema, "query"), async (request, response) => {
    const report = await service.getSalesReport(request.validated.query);
    response.status(200).json({
      success: true,
      data: report,
      message: "Sales analytics retrieved",
      error: null,
    });
  });
  return router;
}
