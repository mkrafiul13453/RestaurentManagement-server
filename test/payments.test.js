import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { Payment, PAYMENT_STATUSES, StripeEvent } from "../src/models/payment.js";

const customerOrderId = "000000000000000000000011";
const secondOrderId = "000000000000000000000012";
const otherOrderId = "000000000000000000000013";
const failedOrderId = "000000000000000000000014";

function createModels() {
  const orders = new Map([
    [customerOrderId, {
      _id: customerOrderId,
      userId: "customer-1",
      status: "pending",
      totalMinor: 1250,
      paymentStatus: "unpaid",
    }],
    [secondOrderId, {
      _id: secondOrderId,
      userId: "customer-1",
      status: "pending",
      totalMinor: 2250,
      paymentStatus: "unpaid",
    }],
    [otherOrderId, {
      _id: otherOrderId,
      userId: "customer-2",
      status: "ready",
      totalMinor: 900,
      paymentStatus: "unpaid",
    }],
    [failedOrderId, {
      _id: failedOrderId,
      userId: "customer-1",
      status: "pending",
      totalMinor: 700,
      paymentStatus: "unpaid",
    }],
  ]);
  const payments = new Map();
  const events = new Map();
  let nextPaymentId = 100;

  function query(getValue) {
    let offset = 0;
    let pageLimit = Infinity;
    return {
      sort() { return this; },
      skip(value) { offset = value; return this; },
      limit(value) { pageLimit = value; return this; },
      async lean() {
        const value = await getValue();
        return Array.isArray(value)
          ? value.slice(offset, offset + pageLimit).map((record) => ({ ...record }))
          : value && { ...value };
      },
    };
  }

  function matches(record, filter) {
    return Object.entries(filter).every(([key, value]) => (
      value && typeof value === "object" && "$in" in value
        ? value.$in.includes(record[key])
        : String(record[key]) === String(value)
    ));
  }

  const Order = {
    findById(id) {
      return query(async () => orders.get(String(id)) ?? null);
    },
    async findByIdAndUpdate(id, update) {
      const order = orders.get(String(id));
      if (!order) return null;
      Object.assign(order, update.$set);
      return { ...order };
    },
  };
  const Payment = {
    records: payments,
    async create(fields) {
      const record = {
        ...fields,
        _id: String(nextPaymentId++).padStart(24, "0"),
        stripeSessionId: "",
        stripePaymentIntentId: "",
        refundRequestedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if ([...payments.values()].some((payment) =>
        payment.orderId === record.orderId && payment.status === "pending",
      )) {
        const error = new Error("duplicate pending payment");
        error.code = 11000;
        throw error;
      }
      payments.set(record._id, record);
      return { ...record };
    },
    findById(id) {
      return query(async () => payments.get(String(id)) ?? null);
    },
    findOne(filter) {
      return query(async () => [...payments.values()].find((record) => matches(record, filter)) ?? null);
    },
    find(filter) {
      return query(async () => [...payments.values()].filter((record) => matches(record, filter)));
    },
    countDocuments: async (filter) => [...payments.values()].filter((record) => matches(record, filter)).length,
    async findOneAndUpdate(filter, update) {
      const record = [...payments.values()].find((candidate) => matches(candidate, filter));
      if (!record) return null;
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return { ...record };
    },
    async deleteOne(filter) {
      const record = [...payments.values()].find((candidate) => matches(candidate, filter));
      if (record) payments.delete(record._id);
    },
  };
  const StripeEvent = {
    async create(event) {
      if (events.has(event.eventId)) {
        const error = new Error("duplicate event");
        error.code = 11000;
        throw error;
      }
      events.set(event.eventId, event);
      return event;
    },
  };
  return { Order, Payment, StripeEvent, orders, payments, events };
}

function createStripe() {
  const sessions = new Map();
  const calls = { checkout: [], refunds: [], expires: [] };
  return {
    calls,
    sessions,
    checkout: {
      sessions: {
        async create(params, options) {
          calls.checkout.push({ params, options });
          const id = `cs_test_${calls.checkout.length}`;
          const session = {
            id,
            url: `https://checkout.stripe.com/c/pay/${id}`,
            status: "open",
            payment_status: "unpaid",
            amount_total: params.line_items[0].price_data.unit_amount,
            currency: params.line_items[0].price_data.currency,
            metadata: params.metadata,
          };
          sessions.set(id, session);
          return session;
        },
        async retrieve(id) {
          return sessions.get(id);
        },
        async expire(id) {
          calls.expires.push(id);
          const session = sessions.get(id);
          session.status = "expired";
          return session;
        },
      },
    },
    refunds: {
      async create(params, options) {
        calls.refunds.push({ params, options });
        return { id: "re_test_1", status: "pending" };
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== "valid-signature" || secret !== "whsec_test") {
          throw new Error("invalid signature");
        }
        return JSON.parse(body.toString("utf8"));
      },
    },
  };
}

async function withServer(app, run) {
  const server = createServer(app);
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function headers(role = "customer", userId = "customer-1") {
  return { "x-test-role": role, "x-test-user": userId };
}

test("payment models store required audit fields and enforce active payment/event uniqueness", () => {
  const payment = new Payment({
    orderId: customerOrderId,
    userId: "customer-1",
    amountMinor: 1250,
    currency: "usd",
  });
  assert.equal(payment.status, "pending");
  assert.deepEqual(PAYMENT_STATUSES, ["pending", "paid", "failed", "cancelled", "refunded"]);
  assert.equal(Payment.schema.options.timestamps, true);
  assert.ok(Payment.schema.indexes().some(([keys, options]) =>
    keys.orderId === 1 &&
    options.name === "pending_payment_per_order" &&
    options.unique === true &&
    options.partialFilterExpression.status === "pending",
  ));
  assert.ok(StripeEvent.schema.indexes().some(([keys, options]) =>
    keys.eventId === 1 && options.unique === true,
  ));
});

test("Stripe Checkout uses server order totals and verifies idempotent webhook updates", async () => {
  const models = createModels();
  const stripe = createStripe();
  const auth = {
    api: {
      getSession: async ({ headers: requestHeaders }) => ({
        user: {
          id: requestHeaders.get("x-test-user") ?? "customer-1",
          role: requestHeaders.get("x-test-role"),
        },
      }),
    },
  };
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth,
    ...models,
    MenuItem: {},
    Table: {},
    stripe,
    stripeWebhookSecret: "whsec_test",
  });

  await withServer(app, async (baseUrl) => {
    const checkout = (orderId, role = "customer", userId = "customer-1") =>
      fetch(`${baseUrl}/api/v1/payments/checkout`, {
        method: "POST",
        headers: { ...headers(role, userId), "content-type": "application/json" },
        body: JSON.stringify({ orderId }),
      });

    assert.equal((await checkout(customerOrderId, "customer", "customer-2")).status, 404);
    assert.equal((await checkout(customerOrderId, "waiter")).status, 403);

    const createdResponse = await checkout(customerOrderId);
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).data;
    assert.equal(created.payment.amountMinor, 1250);
    assert.equal(created.payment.currency, "usd");
    assert.equal(created.payment.status, "pending");
    assert.equal(created.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_1");
    assert.equal(stripe.calls.checkout[0].params.line_items.length, 1);
    assert.equal(stripe.calls.checkout[0].params.line_items[0].price_data.unit_amount, 1250);
    assert.equal(stripe.calls.checkout[0].options.idempotencyKey, `restora-checkout-${created.payment._id}`);
    assert.equal(models.orders.get(customerOrderId).paymentStatus, "unpaid");

    const blockedOrderCancel = await fetch(`${baseUrl}/api/v1/orders/${customerOrderId}/status`, {
      method: "PATCH",
      headers: { ...headers("manager"), "content-type": "application/json" },
      body: JSON.stringify({ expectedStatus: "pending", status: "cancelled" }),
    });
    assert.equal(blockedOrderCancel.status, 409);

    const duplicate = await checkout(customerOrderId);
    assert.equal(duplicate.status, 201);
    assert.equal(stripe.calls.checkout.length, 1);

    const event = {
      id: "evt_checkout_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          amount_total: 1250,
          currency: "usd",
          payment_status: "paid",
          payment_intent: "pi_test_1",
          metadata: {
            paymentId: created.payment._id,
            orderId: customerOrderId,
            userId: "customer-1",
          },
        },
      },
    };
    const sendWebhook = (body, signature = "valid-signature") =>
      fetch(`${baseUrl}/api/v1/payments/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: JSON.stringify(body),
      });

    assert.equal((await sendWebhook(event, "invalid")).status, 400);
    assert.equal(models.payments.get(created.payment._id).status, "pending");
    assert.equal((await sendWebhook(event)).status, 200);
    assert.equal(models.payments.get(created.payment._id).status, "paid");
    assert.equal(models.payments.get(created.payment._id).stripePaymentIntentId, "pi_test_1");
    assert.equal(models.orders.get(customerOrderId).paymentStatus, "paid");
    assert.equal((await sendWebhook(event)).status, 200);
    assert.equal(models.events.size, 1);

    const ownerPayment = await fetch(`${baseUrl}/api/v1/payments/${created.payment._id}`, {
      headers: headers("customer", "customer-1"),
    });
    assert.equal(ownerPayment.status, 200);
    const privatePayment = await fetch(`${baseUrl}/api/v1/payments/${created.payment._id}`, {
      headers: headers("customer", "customer-2"),
    });
    assert.equal(privatePayment.status, 404);
  });
});

test("refunds and cancellations are authorized and finalize only after Stripe webhooks", async () => {
  const models = createModels();
  const stripe = createStripe();
  const auth = {
    api: {
      getSession: async ({ headers: requestHeaders }) => ({
        user: {
          id: requestHeaders.get("x-test-user") ?? "customer-1",
          role: requestHeaders.get("x-test-role"),
        },
      }),
    },
  };
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth,
    ...models,
    stripe,
    stripeWebhookSecret: "whsec_test",
  });

  await withServer(app, async (baseUrl) => {
    const checkoutResponse = await fetch(`${baseUrl}/api/v1/payments/checkout`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ orderId: secondOrderId }),
    });
    const payment = (await checkoutResponse.json()).data.payment;
    const sessionId = payment.stripeSessionId;

    const cancelResponse = await fetch(`${baseUrl}/api/v1/payments/${payment._id}/cancel`, {
      method: "POST",
      headers: headers(),
    });
    assert.equal(cancelResponse.status, 202);
    assert.equal(stripe.calls.expires[0], sessionId);
    assert.equal(models.payments.get(payment._id).status, "pending");

    const expiredEvent = {
      id: "evt_checkout_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          id: sessionId,
          amount_total: 2250,
          currency: "usd",
          metadata: {
            paymentId: payment._id,
            orderId: secondOrderId,
            userId: "customer-1",
          },
        },
      },
    };
    await fetch(`${baseUrl}/api/v1/payments/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "valid-signature" },
      body: JSON.stringify(expiredEvent),
    });
    assert.equal(models.payments.get(payment._id).status, "cancelled");
    assert.equal(models.orders.get(secondOrderId).paymentStatus, "unpaid");

    const failedCheckout = await fetch(`${baseUrl}/api/v1/payments/checkout`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ orderId: failedOrderId }),
    });
    const failedPayment = (await failedCheckout.json()).data.payment;
    await fetch(`${baseUrl}/api/v1/payments/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "valid-signature" },
      body: JSON.stringify({
        id: "evt_async_failed",
        type: "checkout.session.async_payment_failed",
        data: {
          object: {
            id: failedPayment.stripeSessionId,
            amount_total: 700,
            currency: "usd",
            metadata: {
              paymentId: failedPayment._id,
              orderId: failedOrderId,
              userId: "customer-1",
            },
          },
        },
      }),
    });
    assert.equal(models.payments.get(failedPayment._id).status, "failed");
    const retry = await fetch(`${baseUrl}/api/v1/payments/checkout`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ orderId: failedOrderId }),
    });
    assert.equal(retry.status, 201);
    assert.equal(stripe.calls.checkout.length, 3);

    const paid = await fetch(`${baseUrl}/api/v1/payments/checkout`, {
      method: "POST",
      headers: { ...headers("customer", "customer-2"), "content-type": "application/json" },
      body: JSON.stringify({ orderId: otherOrderId }),
    });
    assert.equal(paid.status, 201);
    const paidPayment = (await paid.json()).data.payment;
    const session = stripe.sessions.get(paidPayment.stripeSessionId);
    await fetch(`${baseUrl}/api/v1/payments/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "valid-signature" },
      body: JSON.stringify({
        id: "evt_other_paid",
        type: "checkout.session.completed",
        data: {
          object: {
            id: session.id,
            amount_total: 900,
            currency: "usd",
            payment_status: "paid",
            payment_intent: "pi_test_2",
            metadata: {
              paymentId: paidPayment._id,
              orderId: otherOrderId,
              userId: "customer-2",
            },
          },
        },
      }),
    });

    const deniedRefund = await fetch(`${baseUrl}/api/v1/payments/${paidPayment._id}/refund`, {
      method: "POST",
      headers: headers("customer", "customer-2"),
    });
    assert.equal(deniedRefund.status, 403);
    const refund = await fetch(`${baseUrl}/api/v1/payments/${paidPayment._id}/refund`, {
      method: "POST",
      headers: headers("cashier"),
    });
    assert.equal(refund.status, 202);
    assert.equal(stripe.calls.refunds[0].params.payment_intent, "pi_test_2");
    assert.equal(models.payments.get(paidPayment._id).status, "paid");

    await fetch(`${baseUrl}/api/v1/payments/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "valid-signature" },
      body: JSON.stringify({
        id: "evt_refund_completed",
        type: "charge.refunded",
        data: {
          object: {
            payment_intent: "pi_test_2",
            amount_refunded: 900,
            currency: "usd",
          },
        },
      }),
    });
    assert.equal(models.payments.get(paidPayment._id).status, "refunded");
    assert.equal(models.orders.get(otherOrderId).paymentStatus, "refunded");
  });
});
