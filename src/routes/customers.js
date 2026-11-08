import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const customerQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createCustomersRouter({ auth, database }) {
  const router = Router();
  const users = database.collection("user");

  router.get(
    "/",
    requireAuth(auth),
    requireRole("admin", "manager"),
    validate(customerQuerySchema, "query"),
    async (request, response) => {
      const { page, limit, search } = request.validated.query;
      const filter = { role: "customer" };
      if (search) {
        filter.email = { $regex: escapeRegex(search), $options: "i" };
      }

      const [total, records] = await Promise.all([
        users.countDocuments(filter),
        users
          .find(filter, { projection: { _id: 0, email: 1 } })
          .sort({ email: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);

      response.status(200).json({
        success: true,
        data: {
          customers: records.map(({ email }) => ({ email })),
        },
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        message: "Customers retrieved",
        error: null,
      });
    },
  );

  return router;
}
