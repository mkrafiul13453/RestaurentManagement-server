import { AppError } from "../utils/app-error.js";

const staffRoles = ["admin", "manager", "cashier"];

function required(record, message = "Payment not found") {
  if (!record) throw new AppError(message, 404, "NOT_FOUND");
  return record;
}

function toPlain(record) {
  return typeof record.toObject === "function" ? record.toObject() : record;
}

function serializePayment(payment) {
  const value = toPlain(payment);
  return {
    _id: String(value._id),
    orderId: String(value.orderId),
    userId: value.userId,
    amountMinor: value.amountMinor,
    currency: value.currency,
    status: value.status,
    stripeSessionId: value.stripeSessionId,
    stripePaymentIntentId: value.stripePaymentIntentId,
    refundRequestedAt: value.refundRequestedAt ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

function canAccessPayment(payment, { role, userId }) {
  return role !== "customer" || payment.userId === userId;
}

export function createPaymentService({
  Order,
  Payment,
  StripeEvent,
  stripe,
  clientOrigin,
  notificationService,
}) {
  function requireStripe() {
    if (!stripe) {
      throw new AppError("Stripe payments are not configured on the server", 503, "PAYMENTS_NOT_CONFIGURED");
    }
  }

  async function findPayment(id) {
    return Payment.findById(id).lean();
  }

  async function updatePayment(filter, update) {
    return Payment.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true, runValidators: true },
    );
  }

  async function processEvent(event) {
    const object = event.data.object;
    if (event.type.startsWith("checkout.session.")) {
      const payment = object.metadata?.paymentId
        ? await findPayment(object.metadata.paymentId)
        : await Payment.findOne({ stripeSessionId: object.id }).lean();
      if (!payment || payment.stripeSessionId !== object.id) return;

      if (
        object.amount_total !== payment.amountMinor ||
        object.currency !== payment.currency ||
        object.metadata?.orderId !== String(payment.orderId) ||
        object.metadata?.userId !== payment.userId
      ) {
        throw new AppError("Stripe session does not match the recorded payment", 400, "PAYMENT_AMOUNT_MISMATCH");
      }

      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        if (object.payment_status !== "paid") return;
        const paymentIntentId = typeof object.payment_intent === "string"
          ? object.payment_intent
          : object.payment_intent?.id ?? "";
        if (!paymentIntentId) {
          throw new AppError("Stripe did not provide a payment intent", 400, "PAYMENT_INTENT_MISSING");
        }
        const updated = await updatePayment(
          { _id: payment._id, status: "pending" },
          { status: "paid", stripePaymentIntentId: paymentIntentId },
        );
        if (updated || (await findPayment(payment._id))?.status === "paid") {
          await Order.findByIdAndUpdate(
            payment.orderId,
            { $set: { paymentStatus: "paid" } },
            { runValidators: true },
          );
          await notificationService?.statusChanged({
            resourceType: "payment",
            resourceId: payment._id,
            ownerId: payment.userId,
            previousStatus: "pending",
            newStatus: "paid",
          });
        }
        return;
      }

      if (event.type === "checkout.session.async_payment_failed") {
        const updated = await updatePayment(
          { _id: payment._id, status: "pending" },
          { status: "failed" },
        );
        if (updated || (await findPayment(payment._id))?.status === "failed") {
          await notificationService?.statusChanged({
            resourceType: "payment",
            resourceId: payment._id,
            ownerId: payment.userId,
            previousStatus: "pending",
            newStatus: "failed",
          });
        }
      } else if (event.type === "checkout.session.expired") {
        const updated = await updatePayment(
          { _id: payment._id, status: "pending" },
          { status: "cancelled" },
        );
        if (updated || (await findPayment(payment._id))?.status === "cancelled") {
          await notificationService?.statusChanged({
            resourceType: "payment",
            resourceId: payment._id,
            ownerId: payment.userId,
            previousStatus: "pending",
            newStatus: "cancelled",
          });
        }
      }
      return;
    }

    if (event.type === "charge.refunded") {
      const paymentIntentId = typeof object.payment_intent === "string"
        ? object.payment_intent
        : object.payment_intent?.id;
      if (!paymentIntentId) return;
      const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId }).lean();
      if (
        !payment ||
        object.currency !== payment.currency ||
        object.amount_refunded < payment.amountMinor
      ) return;
      const updated = await updatePayment(
        { _id: payment._id, status: "paid" },
        { status: "refunded" },
      );
      if (updated || payment.status === "refunded") {
        await Order.findByIdAndUpdate(
          payment.orderId,
          { $set: { paymentStatus: "refunded" } },
          { runValidators: true },
        );
        await notificationService?.statusChanged({
          resourceType: "payment",
          resourceId: payment._id,
          ownerId: payment.userId,
          previousStatus: "paid",
          newStatus: "refunded",
        });
      }
    }
  }

  return {
    async createCheckout({ orderId, role, userId }) {
      requireStripe();
      const order = required(await Order.findById(orderId).lean(), "Order not found");
      if (role === "customer" && order.userId !== userId) {
        throw new AppError("Order not found", 404, "NOT_FOUND");
      }
      if (order.status === "cancelled") {
        throw new AppError("Cancelled orders cannot be paid", 409, "ORDER_CANCELLED");
      }
      if (!Number.isSafeInteger(order.totalMinor) || order.totalMinor < 1) {
        throw new AppError("Order has an invalid total", 409, "INVALID_ORDER_AMOUNT");
      }
      if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
        throw new AppError("This order has already been paid", 409, "ORDER_ALREADY_PAID");
      }

      const current = await Payment.findOne({ orderId, status: "pending" }).lean();
      if (current) {
        if (current.stripeSessionId) {
          const session = await stripe.checkout.sessions.retrieve(current.stripeSessionId);
          if (session.status === "open" && session.url) {
            return { payment: serializePayment(current), checkoutUrl: session.url };
          }
        }
        throw new AppError(
          "A payment attempt is still processing. Wait for Stripe to confirm its status before retrying.",
          409,
          "PAYMENT_ALREADY_PENDING",
        );
      }

      let payment;
      try {
        payment = await Payment.create({
          orderId,
          userId: order.userId,
          amountMinor: order.totalMinor,
          currency: "usd",
          status: "pending",
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        throw new AppError("A payment attempt is already in progress", 409, "PAYMENT_ALREADY_PENDING");
      }

      try {
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            line_items: [{
              price_data: {
                currency: "usd",
                product_data: { name: `Restora order ${String(order._id).slice(-8)}` },
                unit_amount: order.totalMinor,
              },
              quantity: 1,
            }],
            client_reference_id: String(order._id),
            metadata: {
              orderId: String(order._id),
              paymentId: String(payment._id),
              userId: order.userId,
            },
            payment_intent_data: {
              metadata: {
                orderId: String(order._id),
                paymentId: String(payment._id),
              },
            },
            success_url: `${clientOrigin}/payment/success?payment_id=${encodeURIComponent(String(payment._id))}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientOrigin}/payment/cancel?payment_id=${encodeURIComponent(String(payment._id))}`,
          },
          { idempotencyKey: `restora-checkout-${String(payment._id)}` },
        );
        if (!session.id || !session.url) {
          throw new AppError("Stripe did not return a checkout URL", 502, "STRIPE_CHECKOUT_FAILED");
        }
        const savedPayment = await updatePayment(
          { _id: payment._id, status: "pending" },
          { stripeSessionId: session.id },
        );
        if (!savedPayment) {
          throw new AppError("Could not save the Stripe checkout session", 500, "PAYMENT_SAVE_FAILED");
        }
        return { payment: serializePayment(savedPayment), checkoutUrl: session.url };
      } catch (error) {
        if (error instanceof AppError) throw error;
        await Payment.deleteOne({ _id: payment._id, status: "pending", stripeSessionId: "" });
        throw new AppError("Could not start Stripe Checkout. Please try again.", 502, "STRIPE_CHECKOUT_FAILED");
      }
    },

    async getPayment(id, actor) {
      const payment = required(await findPayment(id));
      if (!canAccessPayment(payment, actor)) {
        throw new AppError("Payment not found", 404, "NOT_FOUND");
      }
      return serializePayment(payment);
    },

    async listPayments({ role, userId, page, limit, orderId }) {
      const filter = {};
      if (role === "customer") filter.userId = userId;
      if (orderId) filter.orderId = orderId;
      const [total, payments] = await Promise.all([
        Payment.countDocuments(filter),
        Payment.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return {
        payments: payments.map(serializePayment),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async cancelPayment(id, actor) {
      requireStripe();
      const payment = required(await findPayment(id));
      if (!canAccessPayment(payment, actor) && !staffRoles.includes(actor.role)) {
        throw new AppError("Payment not found", 404, "NOT_FOUND");
      }
      if (payment.status !== "pending" || !payment.stripeSessionId) {
        throw new AppError("Only a pending Checkout session can be cancelled", 409, "PAYMENT_NOT_CANCELLABLE");
      }
      const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
      if (session.status === "complete") {
        throw new AppError("This Checkout session is complete and cannot be cancelled", 409, "PAYMENT_NOT_CANCELLABLE");
      }
      if (session.status === "open") {
        await stripe.checkout.sessions.expire(payment.stripeSessionId);
      }
      return { payment: serializePayment(payment), message: "Cancellation requested; waiting for Stripe confirmation." };
    },

    async refundPayment(id) {
      requireStripe();
      const payment = required(await findPayment(id));
      if (payment.status !== "paid" || !payment.stripePaymentIntentId) {
        throw new AppError("Only a completed payment can be refunded", 409, "PAYMENT_NOT_REFUNDABLE");
      }
      const refund = await stripe.refunds.create(
        {
          payment_intent: payment.stripePaymentIntentId,
          reason: "requested_by_customer",
        },
        { idempotencyKey: `restora-refund-${String(payment._id)}` },
      );
      await updatePayment(
        { _id: payment._id, status: "paid", refundRequestedAt: null },
        { refundRequestedAt: new Date() },
      );
      return { refundId: refund.id, status: refund.status };
    },

    async handleStripeEvent(event) {
      await processEvent(event);
      try {
        await StripeEvent.create({ eventId: event.id, type: event.type });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    },
  };
}
