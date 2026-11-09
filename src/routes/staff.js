import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { AUTH_ROLES } from "../auth/auth.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { AppError } from "../utils/app-error.js";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  role: z.enum(AUTH_ROLES).optional(),
}).strict();

const userIdSchema = z.object({
  id: z.string().min(1).max(128),
});

const changeRoleSchema = z.object({
  expectedRole: z.enum(AUTH_ROLES),
  role: z.enum(AUTH_ROLES),
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

function serializeUser(user) {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function authHeaders(request) {
  return fromNodeHeaders(request.headers);
}

function assertAuthApiAvailable(auth) {
  if (
    !auth?.api ||
    typeof auth.api.listUsers !== "function" ||
    typeof auth.api.getUser !== "function" ||
    typeof auth.api.setRole !== "function"
  ) {
    throw new AppError("Better Auth staff management APIs are not configured", 503, "STAFF_API_UNAVAILABLE");
  }
}

async function callAuthApi(operation) {
  try {
    return await operation();
  } catch (error) {
    if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
      throw new AppError(
        error.message || "Better Auth rejected the staff operation",
        error.statusCode,
        error.body?.code || error.code || "BETTER_AUTH_REQUEST_FAILED",
      );
    }
    throw error;
  }
}

export function createStaffRouter({ auth, database }) {
  const router = Router();
  router.use(requireAuth(auth), requireRole("admin"));

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    assertAuthApiAvailable(auth);
    const { page, limit, search, role } = request.validated.query;
    const query = {
      limit,
      offset: (page - 1) * limit,
      sortBy: "createdAt",
      sortDirection: "desc",
      filterField: "role",
      filterOperator: role ? "eq" : "in",
      filterValue: role ?? AUTH_ROLES,
      ...(search
        ? {
          searchField: "email",
          searchOperator: "contains",
          searchValue: search,
        }
        : {}),
    };
    const result = await callAuthApi(
      () => auth.api.listUsers({ headers: authHeaders(request), query }),
    );
    const users = Array.isArray(result?.users) ? result.users : null;
    const total = result?.total;
    if (!users || !Number.isInteger(total) || total < 0) {
      throw new AppError("Better Auth returned an invalid staff list", 502, "INVALID_STAFF_LIST");
    }

    respond(
      response,
      { staff: users.map(serializeUser) },
      "Staff accounts retrieved",
      200,
      { page, limit, total, totalPages: Math.ceil(total / limit) },
    );
  });

  router.patch(
    "/:id/role",
    validate(userIdSchema, "params"),
    validate(changeRoleSchema),
    async (request, response) => {
      assertAuthApiAvailable(auth);
      const { id } = request.validated.params;
      const { expectedRole, role } = request.validated.body;
      const actorId = String(request.user.id);
      if (id === actorId) {
        throw new AppError("Administrators cannot change their own role", 403, "SELF_ROLE_CHANGE_FORBIDDEN");
      }
      if (expectedRole === role) {
        throw new AppError("Choose a different role", 400, "ROLE_UNCHANGED");
      }

      const headers = authHeaders(request);
      const target = await callAuthApi(() => auth.api.getUser({ headers, query: { id } }));
      if (!target || String(target.id) !== id || !AUTH_ROLES.includes(target.role)) {
        throw new AppError("Staff account not found or has an invalid role", 404, "STAFF_NOT_FOUND");
      }
      if (target.role !== expectedRole) {
        throw new AppError("This account's role has changed. Refresh and try again.", 409, "STAFF_ROLE_CONFLICT");
      }
      const previousRole = target.role;

      const result = await callAuthApi(() => auth.api.setRole({
        headers,
        body: { userId: id, role },
      }));
      const updatedUser = result?.user;
      if (!updatedUser || String(updatedUser.id) !== id || updatedUser.role !== role) {
        throw new AppError("Better Auth returned an invalid role update", 502, "INVALID_ROLE_UPDATE");
      }

      const audit = {
        actorId,
        actorEmail: request.user.email,
        targetUserId: id,
        targetEmail: target.email,
        previousRole,
        newRole: updatedUser.role,
        changedAt: new Date(),
      };
      try {
        await database.collection("staff_role_audits").insertOne(audit);
      } catch (error) {
        console.error("Staff role changed but audit logging failed", {
          actorId,
          targetUserId: id,
          error,
        });
        throw new AppError(
          "The role was changed, but its audit record could not be saved. Contact an administrator.",
          500,
          "STAFF_AUDIT_FAILED",
        );
      }

      respond(response, { staff: serializeUser(updatedUser) }, "Staff role updated");
    },
  );

  return router;
}
