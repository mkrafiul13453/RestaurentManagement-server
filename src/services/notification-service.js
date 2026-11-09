import { AppError } from "../utils/app-error.js";

const staffRolesByResource = {
  order: ["chef", "waiter"],
  reservation: ["manager", "waiter"],
  payment: ["cashier"],
};

const eventTypeByResource = {
  order: "order_status_changed",
  reservation: "reservation_status_changed",
  payment: "payment_status_changed",
};

function isDuplicateKey(error) {
  return error?.code === 11000;
}

export function createNotificationService({ Notification, userCollection }) {
  async function getActiveStaffIds(roles) {
    const now = new Date();
    const users = await userCollection.find(
      {
        role: { $in: roles },
        banned: { $ne: true },
        $or: [
          { banExpires: { $exists: false } },
          { banExpires: null },
          { banExpires: { $lte: now } },
        ],
      },
      { projection: { id: 1, _id: 1 } },
    ).toArray();
    return users.map((user) => String(user.id ?? user._id)).filter(Boolean);
  }

  return {
    async statusChanged({ resourceType, resourceId, ownerId, previousStatus, newStatus }) {
      if (previousStatus === newStatus) return [];
      const type = eventTypeByResource[resourceType];
      const staffRoles = staffRolesByResource[resourceType];
      if (!type || !staffRoles || !ownerId || !resourceId) {
        throw new AppError("Cannot create a notification for this status event", 500, "INVALID_NOTIFICATION_EVENT");
      }

      const recipientIds = new Set([
        String(ownerId),
        ...await getActiveStaffIds(staffRoles),
      ]);
      const eventKey = `${type}:${String(resourceId)}:${previousStatus}:${newStatus}`;
      const records = [...recipientIds].map((recipientId) => ({
        recipientId,
        eventKey,
        type,
        resourceType,
        resourceId: String(resourceId),
        previousStatus,
        newStatus,
        isRead: false,
        readAt: null,
      }));

      for (const record of records) {
        try {
          await Notification.create(record);
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          const existing = await Notification.exists({
            eventKey: record.eventKey,
            recipientId: record.recipientId,
          });
          if (!existing) throw error;
        }
      }
      return [...recipientIds];
    },
  };
}
