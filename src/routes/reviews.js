import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createReviewService } from "../services/review-service.js";

const orderIdPattern = /^[\da-f]{24}$/i;
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  orderIds: z.string().max(2500).optional().refine(
    (value) => !value || value.split(",").length <= 100 && value.split(",").every((id) => orderIdPattern.test(id)),
    "orderIds must be comma-separated MongoDB IDs",
  ),
}).strict();
const reviewSchema = z.object({
  orderId: z.string().regex(orderIdPattern),
  rating: z.number().int().min(1).max(5),
  text: z.string()
    .trim()
    .min(10)
    .max(1000)
    .refine((value) => /[\p{L}\p{N}]/u.test(value), "Review text must include letters or numbers")
    .refine(
      (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
      "Review text cannot contain control characters",
    ),
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

export function createReviewsRouter({ auth, Review, Order }) {
  const router = Router();
  const service = createReviewService({ Review, Order });
  router.use(requireAuth(auth), requireRole("customer"));

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const { page, limit, orderIds } = request.validated.query;
    const result = await service.list({
      userId: request.user.id,
      page,
      limit,
      orderIds: orderIds?.split(","),
    });
    respond(response, { reviews: result.reviews }, "Reviews retrieved", 200, result.meta);
  });

  router.post("/", validate(reviewSchema), async (request, response) => {
    const review = await service.create({
      ...request.validated.body,
      userId: request.user.id,
    });
    respond(response, { review }, "Review submitted", 201);
  });

  return router;
}
