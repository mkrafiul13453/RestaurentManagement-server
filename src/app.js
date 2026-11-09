import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createApiRouter } from "./routes/index.js";
import { AppError } from "./utils/app-error.js";
import { createNotificationService } from "./services/notification-service.js";
import {
  createStripeWebhookHandler,
  createStripeWebhookService,
} from "./routes/payments.js";

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_request, response) => {
    response.status(429).json({
      success: false,
      data: null,
      message: "Too many authentication requests. Please try again later.",
      error: { code: "RATE_LIMITED" },
    });
  },
});

export function createApp({
  clientOrigin,
  auth,
  authHandler,
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
  stripeWebhookSecret = "",
}) {
  const app = express();
  const notificationService = database && Notification
    ? createNotificationService({
      Notification,
      userCollection: database.collection("user"),
    })
    : undefined;
  const authRouteHandler = authHandler ?? (auth ? toNodeHandler(auth) : undefined);
  const handleAuth = authRouteHandler
    ? (request, response, next) => {
      if (request.path === "/api/auth/admin" || request.path.startsWith("/api/auth/admin/")) {
        response.status(404).json({
          success: false,
          data: null,
          message: "Route not found",
          error: { code: "NOT_FOUND" },
        });
        return;
      }
      authRouteHandler(request, response, next);
    }
    : undefined;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: clientOrigin,
      credentials: true,
    }),
  );

  if (handleAuth) {
    app.all("/api/auth/*splat", authRateLimit, handleAuth);
  }

  if (Payment && StripeEvent) {
    const webhookService = createStripeWebhookService({
      Order,
      Payment,
      StripeEvent,
      stripe,
      clientOrigin,
      notificationService,
    });
    app.post(
      "/api/v1/payments/webhook",
      express.raw({ type: "application/json", limit: "1mb" }),
      createStripeWebhookHandler({ stripe, webhookSecret: stripeWebhookSecret, service: webhookService }),
    );
  }

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({
      success: true,
      data: { status: "ok" },
      message: "Restora API is running",
      error: null,
    });
  });

  app.use(
    "/api/v1",
    createApiRouter({
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
      publishOrderUpdate,
      imgbbApiKey,
      imageUploadFetch,
      taxRateBasisPoints,
      taxRoundingPolicy,
      runInTransaction,
      Payment,
      StripeEvent,
      stripe,
      clientOrigin,
      notificationService,
    }),
  );
  app.use("/api/v1", (_request, _response, next) => {
    next(new AppError("API route not found", 404, "NOT_FOUND"));
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
