import { fromNodeHeaders } from "better-auth/node";
import { AppError } from "../utils/app-error.js";

export function requireAuth(auth) {
  return async function sessionMiddleware(request, _response, next) {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });

      if (!session?.user) {
        throw new AppError("Authentication required", 401, "UNAUTHORIZED");
      }

      request.user = session.user;
      request.session = session.session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(...allowedRoles) {
  return function roleMiddleware(request, _response, next) {
    if (!request.user) {
      next(new AppError("Authentication required", 401, "UNAUTHORIZED"));
      return;
    }

    const role =
      typeof request.user.role === "string"
        ? request.user.role.trim().toLowerCase()
        : "";

    if (!allowedRoles.includes(role)) {
      next(new AppError("You do not have permission to perform this action", 403, "FORBIDDEN"));
      return;
    }

    next();
  };
}
