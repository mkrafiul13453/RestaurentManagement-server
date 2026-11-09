import { Router } from "express";
import { createCustomersRouter } from "./customers.js";
import { createTablesRouter } from "./tables.js";
import { createCategoriesRouter, createMenuItemsRouter } from "./catalog.js";
import { createOrdersRouter } from "./orders.js";
import { createKitchenRouter } from "./kitchen.js";
import { createReservationsRouter } from "./reservations.js";
import { createPaymentsRouter } from "./payments.js";
import { createIngredientsRouter, createInventoryRouter } from "./inventory.js";
import { createStaffRouter } from "./staff.js";
import { createReviewsRouter } from "./reviews.js";
import { createNotificationsRouter } from "./notifications.js";
import { createAnalyticsRouter } from "./analytics.js";

export function createApiRouter({
  auth,
  database,
  Table,
  Category,
  MenuItem,
  Order,
  Review,
  Notification,
  Reservation,
  Ingredient,
  InventoryAdjustment,
  publishOrderUpdate = () => {},
  imgbbApiKey = "",
  imageUploadFetch = fetch,
  taxRateBasisPoints = 500,
  taxRoundingPolicy = "half_up",
  runInTransaction,
  Payment,
  StripeEvent,
  stripe,
  clientOrigin = "",
  notificationService,
} = {}) {
  const apiRouter = Router();

  apiRouter.get("/", (_request, response) => {
    response.status(200).json({
      success: true,
      data: { name: "Restora API", version: 1 },
      message: "Restora API is ready for feature routes",
      error: null,
    });
  });

  apiRouter.get("/health", (_request, response) => {
    response.status(200).json({
      success: true,
      data: { status: "ok" },
      message: "Restora API is running",
      error: null,
    });
  });

  if (auth && database) {
    apiRouter.use("/customers", createCustomersRouter({ auth, database }));
    apiRouter.use("/staff", createStaffRouter({ auth, database }));
  }

  if (auth && Review && Order) {
    apiRouter.use("/reviews", createReviewsRouter({ auth, Review, Order }));
  }

  if (auth && Notification) {
    apiRouter.use("/notifications", createNotificationsRouter({ auth, Notification }));
  }

  if (auth && Order && Payment) {
    apiRouter.use("/analytics", createAnalyticsRouter({ auth, Order, Payment }));
  }

  if (auth && Table) {
    apiRouter.use("/tables", createTablesRouter({ auth, Table, Reservation, runInTransaction }));
  }

  if (auth && Table && Reservation) {
    apiRouter.use(
      "/reservations",
      createReservationsRouter({ auth, Reservation, Table, runInTransaction, notificationService }),
    );
  }

  if (auth && Category && MenuItem) {
    apiRouter.use("/categories", createCategoriesRouter({ auth, Category, MenuItem }));
    apiRouter.use(
      "/menu-items",
      createMenuItemsRouter({ auth, Category, MenuItem, imgbbApiKey, imageUploadFetch }),
    );
  }

  if (auth && Ingredient && InventoryAdjustment) {
    apiRouter.use(
      "/ingredients",
      createIngredientsRouter({ auth, Ingredient, InventoryAdjustment, runInTransaction }),
    );
    apiRouter.use(
      "/inventory",
      createInventoryRouter({ auth, Ingredient, InventoryAdjustment, runInTransaction }),
    );
  }

  if (auth && Order) {
    apiRouter.use("/kitchen", createKitchenRouter({ auth, Order }));
  }

  if (auth && MenuItem && Order && Table) {
    apiRouter.use(
      "/orders",
      createOrdersRouter({
        auth,
        MenuItem,
        Order,
        publishOrderUpdate,
        Table,
        taxRateBasisPoints,
        taxRoundingPolicy,
        runInTransaction,
        Payment,
        notificationService,
      }),
    );
  }

  if (auth && Order && Payment && StripeEvent) {
    apiRouter.use(
      "/payments",
      createPaymentsRouter({
        auth,
        Order,
        Payment,
        StripeEvent,
        stripe,
        clientOrigin,
        notificationService,
      }),
    );
  }

  return apiRouter;
}

export const apiRouter = createApiRouter();
