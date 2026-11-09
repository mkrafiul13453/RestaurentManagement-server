import { Router } from "express";
import { z } from "zod";
import { AUTH_ROLES } from "../auth/auth.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { AppError } from "../utils/app-error.js";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  isRead: z.enum(["true", "false"]).optional(),
}).strict();
const notificationIdSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "Notification ID must be a valid MongoDB ID"),
});
const readSchema = z.object({ isRead: z.boolean() }).strict();

function serializeNotification(notification) {
  return {
    id: String(notification._id ?? notification.id),
    type: notification.type,
    resourceType: notification.resourceType,
    resourceId: notification.resourceId,
    previousStatus: notification.previousStatus,
    newStatus: notification.newStatus,
    isRead: notification.isRead,
    readAt: notification.readAt ?? null,
    createdAt: notification.createdAt,
  };
}

function respond(response, data, message, status = 200, meta) {
  response.status(status).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
    message,
    error: null,
  });
}

export function createNotificationsRouter({ auth, Notification }) {
  const router = Router();
  router.use(requireAuth(auth), requireRole(...AUTH_ROLES));

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const { page, limit, isRead } = request.validated.query;
    const filter = { recipientId: String(request.user.id) };
    if (isRead !== undefined) filter.isRead = isRead === "true";
    const [total, records] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    respond(
      response,
      { notifications: records.map(serializeNotification) },
      "Notifications retrieved",
      200,
      { page, limit, total, totalPages: Math.ceil(total / limit) },
    );
  });

  router.patch(
    "/:id/read",
    validate(notificationIdSchema, "params"),
    validate(readSchema),
    async (request, response) => {
      const { id } = request.validated.params;
      const { isRead } = request.validated.body;
      const notification = await Notification.findOneAndUpdate(
        { _id: id, recipientId: String(request.user.id) },
        { $set: { isRead, readAt: isRead ? new Date() : null } },
        { new: true, runValidators: true },
      ).lean();
      if (!notification) {
        throw new AppError("Notification not found", 404, "NOT_FOUND");
      }
      respond(response, { notification: serializeNotification(notification) }, "Notification read state updated");
    },
  );

  return router;
}
