import { Router } from "express";
import { createCustomersRouter } from "./customers.js";
import { createTablesRouter } from "./tables.js";
import { createCategoriesRouter, createMenuItemsRouter } from "./catalog.js";
import { createOrdersRouter } from "./orders.js";
import { createKitchenRouter } from "./kitchen.js";
import { createReservationsRouter } from "./reservations.js";
import { createPaymentsRouter } from "./payments.js";
import { createIngredientsRouter, createInventoryRouter } from "./inventory.js";

export function createApiRouter({
  auth,
  database,
  Table,
  Category,
  MenuItem,
  Order,
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
  }

  if (auth && Table) {
    apiRouter.use("/tables", createTablesRouter({ auth, Table, Reservation, runInTransaction }));
  }

  if (auth && Table && Reservation) {
    apiRouter.use(
      "/reservations",
      createReservationsRouter({ auth, Reservation, Table, runInTransaction }),
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
      }),
    );
  }

  return apiRouter;
}

export const apiRouter = createApiRouter();
