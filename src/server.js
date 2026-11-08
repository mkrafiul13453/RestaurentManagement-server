import "dotenv/config";
import { createApp } from "./app.js";
import { connectDatabases } from "./config/database.js";
import { readEnv } from "./config/env.js";
import { Table } from "./models/table.js";
import { Category } from "./models/category.js";
import { MenuItem } from "./models/menu-item.js";
import { Order } from "./models/order.js";
import { Reservation } from "./models/reservation.js";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createRealtimeServer } from "./realtime/socket-server.js";
import Stripe from "stripe";
import { Payment, StripeEvent } from "./models/payment.js";
import { Ingredient, InventoryAdjustment } from "./models/ingredient.js";

async function start() {
  const config = readEnv();
  const resources = await connectDatabases(config);
  try {
    await Promise.all([
      Payment.init(),
      StripeEvent.init(),
      Ingredient.init(),
      InventoryAdjustment.init(),
    ]);
  } catch (error) {
    await resources.close();
    throw new Error("Could not initialize database indexes", { cause: error });
  }
  const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
  let io;
  const app = createApp({
    clientOrigin: config.clientOrigin,
    auth: resources.auth,
    database: resources.database,
    Table,
    Category,
    MenuItem,
    Order,
    Reservation,
    Ingredient,
    InventoryAdjustment,
    Payment,
    StripeEvent,
    stripe,
    stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET,
    publishOrderUpdate: (order) => io?.publishOrderUpdate(order),
    imgbbApiKey: config.IMGBB_API_KEY,
    taxRateBasisPoints: config.ORDER_TAX_RATE_BASIS_POINTS,
    taxRoundingPolicy: config.ORDER_TAX_ROUNDING_POLICY,
    runInTransaction: async (operation) => {
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
    },
  });

  const server = createServer(app);
  io = createRealtimeServer({
    server,
    auth: resources.auth,
    clientOrigin: config.clientOrigin,
  });
  server.listen(config.PORT, () => {
    console.log(`Restora API listening on http://localhost:${config.PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Restora API`);

    io.close(async () => {
      try {
        await resources.close();
        process.exitCode = 0;
      } catch {
        console.error("Database shutdown failed");
        process.exitCode = 1;
      }
    });
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error(error.message);
  if (error.cause instanceof Error) {
    const causeMessage = error.cause.message.replace(
      /mongodb(?:\+srv)?:\/\/\S+/gi,
      "[MongoDB URI redacted]",
    );
    console.error(`Cause: ${causeMessage}`);
  }
  process.exitCode = 1;
});
