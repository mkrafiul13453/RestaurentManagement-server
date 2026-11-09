import mongoose from "mongoose";
import { calculateOrderPricing } from "./pricing-service.js";
import { AppError } from "../utils/app-error.js";

const rolesByTransition = {
  "pending:confirmed": ["admin", "manager", "waiter"],
  "pending:cancelled": ["admin", "manager", "waiter"],
  "confirmed:preparing": ["chef"],
  "confirmed:cancelled": ["admin", "manager", "waiter"],
  "preparing:ready": ["chef"],
  "ready:completed": ["cashier"],
};
const stockGatedTransitions = new Set([
  "pending:confirmed",
  "confirmed:preparing",
  "confirmed:cancelled",
  "ready:completed",
]);

function getBilling(order) {
  if (
    !Number.isSafeInteger(order.subtotalMinor) ||
    !Number.isInteger(order.taxRateBasisPoints) ||
    order.taxRateBasisPoints < 0 ||
    order.taxRateBasisPoints > 10000 ||
    order.taxRoundingPolicy !== "half_up" ||
    !Number.isSafeInteger(order.taxMinor) ||
    !Number.isSafeInteger(order.discountMinor) ||
    !Number.isSafeInteger(order.totalMinor)
  ) {
    return null;
  }
  return {
    subtotalMinor: order.subtotalMinor,
    taxRateBasisPoints: order.taxRateBasisPoints,
    taxRoundingPolicy: order.taxRoundingPolicy,
    taxMinor: order.taxMinor,
    discountMinor: order.discountMinor,
    totalMinor: order.totalMinor,
  };
}

function serializeOrder(order) {
  const value = typeof order.toObject === "function" ? order.toObject() : order;
  return { ...value, billing: getBilling(value) };
}

function serializeKitchenOrder(order) {
  const value = typeof order.toObject === "function" ? order.toObject() : order;
  return {
    _id: value._id,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lines: Array.isArray(value.lines)
      ? value.lines.map((line) => ({
        nameSnapshot: line.nameSnapshot,
        quantity: line.quantity,
      }))
      : [],
  };
}

async function defaultRunInTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function required(record, message = "Order not found") {
  if (!record) throw new AppError(message, 404, "NOT_FOUND");
  return record;
}

function conflict(message, code = "ORDER_STATUS_CONFLICT") {
  return new AppError(message, 409, code);
}

export function createOrderService({
  Order,
  MenuItem,
  Table,
  taxRateBasisPoints,
  taxRoundingPolicy = "half_up",
  runInTransaction = defaultRunInTransaction,
  Payment,
  notificationService,
}) {
  return {
    async create({ userId, items, tableId }) {
      const itemIds = items.map(({ menuItemId }) => menuItemId);
      const menuItems = await MenuItem.find({
        _id: { $in: itemIds },
        isAvailable: true,
      }).lean();
      const byId = new Map(menuItems.map((item) => [String(item._id), item]));

      if (byId.size !== items.length) {
        throw new AppError(
          "One or more menu items are unavailable",
          409,
          "MENU_ITEM_UNAVAILABLE",
        );
      }

      const lines = items.map(({ menuItemId, quantity }) => {
        const menuItem = byId.get(menuItemId);
        if (
          !Number.isSafeInteger(menuItem.priceMinor) ||
          menuItem.priceMinor < 1
        ) {
          throw new AppError(
            "A menu item has an invalid stored price",
            409,
            "INVALID_MENU_PRICE",
          );
        }
        const lineTotalMinor = menuItem.priceMinor * quantity;
        if (!Number.isSafeInteger(lineTotalMinor)) {
          throw new AppError("Order line amount is too large", 400, "INVALID_ORDER_AMOUNT");
        }
        return {
          menuItemId: menuItem._id,
          nameSnapshot: menuItem.name,
          quantity,
          unitPriceMinor: menuItem.priceMinor,
          lineTotalMinor,
        };
      });
      const billing = calculateOrderPricing(
        lines,
        taxRateBasisPoints,
        taxRoundingPolicy,
      );
      const orderFields = {
        userId,
        lines,
        status: "pending",
        table: tableId ?? null,
        ...billing,
      };

      if (!tableId) {
        return serializeOrder(await Order.create(orderFields));
      }

      return runInTransaction(async (session) => {
        const [order] = await Order.create([orderFields], { session });
        const table = await Table.findOneAndUpdate(
          {
            _id: tableId,
            status: "available",
            $or: [
              { activeOrderId: null },
              { activeOrderId: { $exists: false } },
            ],
          },
          { $set: { status: "occupied", activeOrderId: order._id } },
          { new: true, runValidators: true, session },
        );
        if (!table) {
          const exists = await Table.exists({ _id: tableId }).session(session);
          if (!exists) throw new AppError("Table not found", 400, "INVALID_TABLE");
          throw conflict("Table is not available for a new order", "TABLE_OCCUPIED");
        }
        return serializeOrder(order);
      });
    },

    async list({ role, userId, page, limit, status }) {
      const filter = {};
      if (role === "customer") filter.userId = userId;
      if (status) filter.status = status;
      const [total, orders] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return {
        orders: orders.map(serializeOrder),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async listKitchen({ page, limit, status }) {
      const filter = {
        status: status ? status : { $in: ["confirmed", "preparing"] },
      };
      const [total, orders] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter)
          .sort({ createdAt: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return {
        orders: orders.map(serializeKitchenOrder),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async getById(id, { role, userId }) {
      const order = required(await Order.findById(id).lean());
      if (role === "customer" && order.userId !== userId) {
        throw new AppError("Order not found", 404, "NOT_FOUND");
      }
      return serializeOrder(order);
    },

    async updateStatus(id, { expectedStatus, status, role }) {
      const transition = `${expectedStatus}:${status}`;
      const allowedRoles = rolesByTransition[transition];
      if (!allowedRoles) {
        throw conflict(
          `Transition from ${expectedStatus} to ${status} is not allowed`,
        );
      }
      if (!allowedRoles.includes(role)) {
        throw new AppError("You do not have permission for this order transition", 403, "FORBIDDEN");
      }
      if (stockGatedTransitions.has(transition)) {
        throw conflict(
          "This order transition is disabled until inventory reservation, release, and consumption are implemented",
          "STOCK_LIFECYCLE_NOT_READY",
        );
      }

      if (status === "cancelled" && Payment) {
        const activePayment = await Payment.findOne({
          orderId: id,
          status: { $in: ["pending", "paid"] },
        }).lean();
        if (activePayment) {
          throw conflict(
            activePayment.status === "paid"
              ? "Refund this payment before cancelling the order"
              : "Cancel the pending Checkout session before cancelling the order",
            "PAYMENT_ACTION_REQUIRED",
          );
        }
      }

      if (status !== "cancelled") {
        const order = await Order.findOneAndUpdate(
          { _id: id, status: expectedStatus },
          { $set: { status } },
          { new: true, runValidators: true },
        );
        if (order) {
          await notificationService?.statusChanged({
            resourceType: "order",
            resourceId: order._id,
            ownerId: order.userId,
            previousStatus: expectedStatus,
            newStatus: status,
          });
          return serializeOrder(order);
        }
        return this.resolveStatusConflict(id);
      }

      const existing = required(await Order.findById(id).lean());
      if (existing.status !== expectedStatus) {
        throw conflict("Order status changed. Refresh and try again.");
      }
      if (!existing.table) {
        const order = await Order.findOneAndUpdate(
          { _id: id, status: expectedStatus },
          { $set: { status } },
          { new: true, runValidators: true },
        );
        if (order) {
          await notificationService?.statusChanged({
            resourceType: "order",
            resourceId: order._id,
            ownerId: order.userId,
            previousStatus: expectedStatus,
            newStatus: status,
          });
          return serializeOrder(order);
        }
        return this.resolveStatusConflict(id);
      }

      const cancelledOrder = await runInTransaction(async (session) => {
        const order = await Order.findOneAndUpdate(
          { _id: id, status: expectedStatus },
          { $set: { status } },
          { new: true, runValidators: true, session },
        );
        if (!order) throw conflict("Order status changed. Refresh and try again.");

        const table = await Table.findOneAndUpdate(
          { _id: existing.table, activeOrderId: order._id, status: "occupied" },
          { $set: { activeOrderId: null, status: "available" } },
          { new: true, runValidators: true, session },
        );
        if (!table) {
          throw conflict(
            "Order cancellation could not release its table; the order was not changed",
            "TABLE_ORDER_LINK_CONFLICT",
          );
        }
        return serializeOrder(order);
      });
      await notificationService?.statusChanged({
        resourceType: "order",
        resourceId: cancelledOrder._id,
        ownerId: cancelledOrder.userId,
        previousStatus: expectedStatus,
        newStatus: status,
      });
      return cancelledOrder;
    },

    async resolveStatusConflict(id) {
      required(await Order.exists({ _id: id }));
      throw conflict("Order status changed. Refresh and try again.");
    },
  };
}
