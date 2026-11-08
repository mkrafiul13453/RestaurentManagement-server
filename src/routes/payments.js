import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPaymentService } from "../services/payment-service.js";
import { AppError } from "../utils/app-error.js";

const staffRoles = ["admin", "manager", "cashier"];
const allowedRoles = [...staffRoles, "customer"];
const paymentIdSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/i, "Payment ID must be a valid MongoDB ID"),
});
const checkoutSchema = z.object({
  orderId: z.string().regex(/^[\da-f]{24}$/i, "Order ID must be a valid MongoDB ID"),
}).strict();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  orderId: z.string().regex(/^[\da-f]{24}$/i).optional(),
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

export function createPaymentsRouter({
  auth,
  Order,
  Payment,
  StripeEvent,
  stripe,
  clientOrigin,
}) {
  const router = Router();
  const service = createPaymentService({ Order, Payment, StripeEvent, stripe, clientOrigin });
  router.use(requireAuth(auth), requireRole(...allowedRoles));

  router.post(
    "/checkout",
    requireRole("customer"),
    validate(checkoutSchema),
    async (request, response) => {
      const result = await service.createCheckout({
        ...request.validated.body,
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, result, "Stripe Checkout session created", 201);
    },
  );

  router.get("/", validate(listQuerySchema, "query"), async (request, response) => {
    const result = await service.listPayments({
      ...request.validated.query,
      role: request.user.role.trim().toLowerCase(),
      userId: request.user.id,
    });
    respond(response, { payments: result.payments }, "Payments retrieved", 200, result.meta);
  });

  router.get("/:id", validate(paymentIdSchema, "params"), async (request, response) => {
    const payment = await service.getPayment(request.validated.params.id, {
      role: request.user.role.trim().toLowerCase(),
      userId: request.user.id,
    });
    respond(response, { payment }, "Payment retrieved");
  });

  router.post(
    "/:id/cancel",
    validate(paymentIdSchema, "params"),
    async (request, response) => {
      const result = await service.cancelPayment(request.validated.params.id, {
        role: request.user.role.trim().toLowerCase(),
        userId: request.user.id,
      });
      respond(response, result, result.message, 202);
    },
  );

  router.post(
    "/:id/refund",
    requireRole(...staffRoles),
    validate(paymentIdSchema, "params"),
    async (request, response) => {
      const result = await service.refundPayment(request.validated.params.id);
      respond(response, result, "Full refund requested", 202);
    },
  );

  return router;
}

export function createStripeWebhookHandler({ stripe, webhookSecret, service }) {
  return async function stripeWebhook(request, response, next) {
    if (!stripe || !webhookSecret) {
      next(new AppError("Stripe webhooks are not configured on the server", 503, "PAYMENTS_NOT_CONFIGURED"));
      return;
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        request.headers["stripe-signature"],
        webhookSecret,
      );
    } catch {
      response.status(400).json({
        success: false,
        data: null,
        message: "Invalid Stripe webhook signature",
        error: { code: "INVALID_WEBHOOK_SIGNATURE" },
      });
      return;
    }

    try {
      await service.handleStripeEvent(event);
      response.status(200).json({ received: true });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeWebhookService({ Order, Payment, StripeEvent, stripe, clientOrigin }) {
  return createPaymentService({ Order, Payment, StripeEvent, stripe, clientOrigin });
}
