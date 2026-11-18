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

function inSession(query, session) {
  return session && typeof query.session === "function" ? query.session(session) : query;
}

function getOrderIngredients(order, menuItems) {
  const menuItemsById = new Map(menuItems.map((item) => [String(item._id), item]));
  const requiredById = new Map();
  for (const line of order.lines ?? []) {
    const menuItem = menuItemsById.get(String(line.menuItemId));
    if (!menuItem?.recipe?.length) {
      throw new AppError(
        `Add an ingredient recipe for ${line.nameSnapshot} before confirming this order`,
        409,
        "RECIPE_NOT_CONFIGURED",
      );
    }
    for (const recipeLine of menuItem.recipe) {
      const ingredientId = String(recipeLine.ingredientId);
      const quantity = recipeLine.quantity * line.quantity;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError("A menu item has an invalid ingredient recipe", 409, "INVALID_RECIPE");
      }
      const current = requiredById.get(ingredientId);
      const totalQuantity = (current?.quantity ?? 0) + quantity;
      if (!Number.isFinite(totalQuantity) || totalQuantity > Number.MAX_SAFE_INTEGER) {
        throw new AppError("The required ingredient amount is too large", 409, "INVALID_RECIPE");
      }
      requiredById.set(ingredientId, {
        ingredientId,
        quantity: totalQuantity,
      });
    }
  }
  return [...requiredById.values()].sort((left, right) =>
    left.ingredientId.localeCompare(right.ingredientId));
}

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
  Ingredient,
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
        inventoryReservationStatus: "none",
        reservedIngredients: [],
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

      if (transition === "pending:confirmed") {
        if (!Ingredient) {
          throw new AppError("Inventory is not configured for order confirmation", 503, "INVENTORY_NOT_CONFIGURED");
        }
        const order = await runInTransaction(async (session) => {
          const current = required(await inSession(Order.findById(id), session).lean());
          if (current.status !== expectedStatus) {
            throw conflict("Order status changed. Refresh and try again.");
          }
          const menuItems = await inSession(
            MenuItem.find({
              _id: { $in: (current.lines ?? []).map((line) => line.menuItemId) },
            }),
            session,
          ).lean();
          const requiredIngredients = getOrderIngredients(current, menuItems);
          const ingredients = await inSession(
            Ingredient.find({
              _id: { $in: requiredIngredients.map(({ ingredientId }) => ingredientId) },
              isActive: true,
            }),
            session,
          ).lean();
          const ingredientsById = new Map(ingredients.map((ingredient) => [
            String(ingredient._id),
            ingredient,
          ]));
          const reservation = [];

          for (const requirement of requiredIngredients) {
            const ingredient = ingredientsById.get(requirement.ingredientId);
            if (!ingredient) {
              throw new AppError(
                "A recipe ingredient is missing or inactive",
                409,
                "INVALID_RECIPE_INGREDIENT",
              );
            }
            const available = ingredient.quantity - (ingredient.reservedQuantity ?? 0);
            if (available < requirement.quantity) {
              throw conflict(
                `Not enough ${ingredient.name}: ${available} ${ingredient.unit} available, ${requirement.quantity} ${ingredient.unit} required`,
                "INSUFFICIENT_INGREDIENT_STOCK",
              );
            }
            const reserved = await Ingredient.findOneAndUpdate(
              {
                _id: requirement.ingredientId,
                isActive: true,
                $expr: {
                  $gte: [
                    {
                      $subtract: [
                        "$quantity",
                        { $ifNull: ["$reservedQuantity", 0] },
                      ],
                    },
                    requirement.quantity,
                  ],
                },
              },
              { $inc: { reservedQuantity: requirement.quantity } },
              { new: true, runValidators: true, session },
            );
            if (!reserved) {
              throw conflict(
                `Not enough ${ingredient.name} is available for this order`,
                "INSUFFICIENT_INGREDIENT_STOCK",
              );
            }
            reservation.push({
              ingredientId: reserved._id,
              nameSnapshot: reserved.name,
              quantity: requirement.quantity,
              unit: reserved.unit,
            });
          }

          const updated = await Order.findOneAndUpdate(
            { _id: id, status: expectedStatus },
            {
              $set: {
                status,
                inventoryReservationStatus: "reserved",
                reservedIngredients: reservation,
              },
            },
            { new: true, runValidators: true, session },
          );
          if (!updated) throw conflict("Order status changed. Refresh and try again.");
          return serializeOrder(updated);
        });
        await notificationService?.statusChanged({
          resourceType: "order",
          resourceId: order._id,
          ownerId: order.userId,
          previousStatus: expectedStatus,
          newStatus: status,
        });
        return order;
      }

      if (transition === "confirmed:cancelled" || transition === "pending:cancelled") {
        const order = await runInTransaction(async (session) => {
          const current = required(await inSession(Order.findById(id), session).lean());
          if (current.status !== expectedStatus) {
            throw conflict("Order status changed. Refresh and try again.");
          }
          if (transition === "confirmed:cancelled") {
            if (
              !Ingredient ||
              current.inventoryReservationStatus !== "reserved" ||
              !current.reservedIngredients?.length
            ) {
              throw conflict(
                "This confirmed order has no active ingredient reservation to release",
                "ORDER_RESERVATION_MISSING",
              );
            }
            for (const item of current.reservedIngredients) {
              const released = await Ingredient.findOneAndUpdate(
                {
                  _id: item.ingredientId,
                  $expr: {
                    $gte: [
                      { $ifNull: ["$reservedQuantity", 0] },
                      item.quantity,
                    ],
                  },
                },
                { $inc: { reservedQuantity: -item.quantity } },
                { new: true, runValidators: true, session },
              );
              if (!released) {
                throw conflict(
                  `Could not release the reserved stock for ${item.nameSnapshot}`,
                  "ORDER_RESERVATION_CONFLICT",
                );
              }
            }
          }

          const update = {
            status,
            ...(transition === "confirmed:cancelled"
              ? { inventoryReservationStatus: "released", reservedIngredients: [] }
              : {}),
          };
          const updated = await Order.findOneAndUpdate(
            { _id: id, status: expectedStatus },
            { $set: update },
            { new: true, runValidators: true, session },
          );
          if (!updated) throw conflict("Order status changed. Refresh and try again.");

          if (current.table) {
            const table = await Table.findOneAndUpdate(
              { _id: current.table, activeOrderId: updated._id, status: "occupied" },
              { $set: { activeOrderId: null, status: "available" } },
              { new: true, runValidators: true, session },
            );
            if (!table) {
              throw conflict(
                "Order cancellation could not release its table; the order was not changed",
                "TABLE_ORDER_LINK_CONFLICT",
              );
            }
          }
          return serializeOrder(updated);
        });
        await notificationService?.statusChanged({
          resourceType: "order",
          resourceId: order._id,
          ownerId: order.userId,
          previousStatus: expectedStatus,
          newStatus: status,
        });
        return order;
      }

      if (transition === "ready:completed") {
        if (!Ingredient) {
          throw new AppError("Inventory is not configured for order completion", 503, "INVENTORY_NOT_CONFIGURED");
        }
        const order = await runInTransaction(async (session) => {
          const current = required(await inSession(Order.findById(id), session).lean());
          if (current.status !== expectedStatus) {
            throw conflict("Order status changed. Refresh and try again.");
          }
          if (
            current.inventoryReservationStatus !== "reserved" ||
            !current.reservedIngredients?.length
          ) {
            throw conflict(
              "This order has no active ingredient reservation to consume",
              "ORDER_RESERVATION_MISSING",
            );
          }
          for (const item of current.reservedIngredients) {
            const consumed = await Ingredient.findOneAndUpdate(
              {
                _id: item.ingredientId,
                $expr: {
                  $and: [
                    { $gte: ["$quantity", item.quantity] },
                    {
                      $gte: [
                        { $ifNull: ["$reservedQuantity", 0] },
                        item.quantity,
                      ],
                    },
                  ],
                },
              },
              {
                $inc: {
                  quantity: -item.quantity,
                  reservedQuantity: -item.quantity,
                },
              },
              { new: true, runValidators: true, session },
            );
            if (!consumed) {
              throw conflict(
                `Could not consume the reserved stock for ${item.nameSnapshot}`,
                "ORDER_RESERVATION_CONFLICT",
              );
            }
          }
          const updated = await Order.findOneAndUpdate(
            { _id: id, status: expectedStatus },
            { $set: { status, inventoryReservationStatus: "consumed" } },
            { new: true, runValidators: true, session },
          );
          if (!updated) throw conflict("Order status changed. Refresh and try again.");
          return serializeOrder(updated);
        });
        await notificationService?.statusChanged({
          resourceType: "order",
          resourceId: order._id,
          ownerId: order.userId,
          previousStatus: expectedStatus,
          newStatus: status,
        });
        return order;
      }

      {
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
    },

    async resolveStatusConflict(id) {
      required(await Order.exists({ _id: id }));
      throw conflict("Order status changed. Refresh and try again.");
    },
  };
}
