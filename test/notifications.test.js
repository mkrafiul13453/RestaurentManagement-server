import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Notification } from "../src/models/notification.js";
import { createNotificationService } from "../src/services/notification-service.js";
import { createOrderService } from "../src/services/order-service.js";
import { createPaymentService } from "../src/services/payment-service.js";
import { createReservationService } from "../src/services/reservation-service.js";

const notificationA = "000000000000000000000001";
const notificationB = "000000000000000000000002";
const users = [
  { id: "customer-a", role: "customer" },
  { id: "chef-1", role: "chef" },
  { id: "chef-2", role: "chef" },
  { id: "waiter-1", role: "waiter" },
  { id: "manager-1", role: "manager" },
  { id: "cashier-1", role: "cashier" },
  { id: "banned-chef", role: "chef", banned: true },
  { id: "other-customer", role: "customer" },
];

function createNotificationModel() {
  const records = [];
  let nextId = 1;
  const matches = (record, filter) =>
    record.recipientId === filter.recipientId &&
    (filter.isRead === undefined || record.isRead === filter.isRead);

  return {
    records,
    async create(fields) {
      if (records.some((record) =>
        record.eventKey === fields.eventKey && record.recipientId === fields.recipientId
      )) {
        const error = new Error("duplicate notification event");
        error.code = 11000;
        throw error;
      }
      const record = {
        ...fields,
        _id: String(nextId++).padStart(24, "0"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.push(record);
      return structuredClone(record);
    },
    async exists(filter) {
      return records.some((record) =>
        record.eventKey === filter.eventKey && record.recipientId === filter.recipientId
      ) ? { _id: "existing" } : null;
    },
    async countDocuments(filter) {
      return records.filter((record) => matches(record, filter)).length;
    },
    find(filter) {
      let offset = 0;
      let limit = Infinity;
      return {
        sort() { return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async lean() {
          return records
            .filter((record) => matches(record, filter))
            .slice()
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(offset, offset + limit)
            .map((record) => structuredClone(record));
        },
      };
    },
    findOneAndUpdate(filter, update) {
      const record = records.find((item) =>
        item._id === String(filter._id) && item.recipientId === filter.recipientId
      );
      if (!record) return { lean: async () => null };
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return { lean: async () => structuredClone(record) };
    },
  };
}

function createUserCollection() {
  return {
    find(filter) {
      return {
        toArray: async () => users.filter((user) =>
          filter.role.$in.includes(user.role) &&
          user.banned !== true &&
          (!user.banExpires || new Date(user.banExpires) <= new Date())
        ).map((user) => structuredClone(user)),
      };
    },
  };
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role
          ? {
            user: {
              id: headers.get("x-test-user") ?? "customer-a",
              role,
            },
          }
          : null;
      },
    },
  };
}

function createTestApp(model = createNotificationModel()) {
  const userCollection = createUserCollection();
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    database: { collection: () => userCollection },
    Notification: model,
  });
  return { app, model, userCollection };
}

async function withServer(app, operation) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

function headers(userId = "customer-a", role = "customer") {
  return {
    "content-type": "application/json",
    "x-test-role": role,
    "x-test-user": userId,
  };
}

test("notification schema validates event states and defines recipient/idempotency indexes", async () => {
  const indexes = Notification.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.eventKey === 1 && fields.recipientId === 1 && options.unique === true
  ));
  assert.ok(indexes.some(([fields]) => fields.recipientId === 1 && fields.createdAt === -1));
  assert.equal(Notification.schema.path("isRead").options.default, false);
  assert.equal(Notification.schema.path("readAt").options.default, null);
  const valid = new Notification({
    recipientId: "customer-a",
    eventKey: "order_status_changed:order-1:pending:confirmed",
    type: "order_status_changed",
    resourceType: "order",
    resourceId: "order-1",
    previousStatus: "pending",
    newStatus: "confirmed",
  });
  await valid.validate();
  const invalid = new Notification({
    recipientId: "customer-a",
    eventKey: "order_status_changed:order-1:pending:paid",
    type: "order_status_changed",
    resourceType: "order",
    resourceId: "order-1",
    previousStatus: "pending",
    newStatus: "paid",
  });
  await assert.rejects(invalid.validate());
});

test("notifications target only approved active roles and owner, with safe status-only data", async () => {
  const model = createNotificationModel();
  const service = createNotificationService({
    Notification: model,
    userCollection: createUserCollection(),
  });
  const recipients = await service.statusChanged({
    resourceType: "order",
    resourceId: "order-1",
    ownerId: "customer-a",
    previousStatus: "pending",
    newStatus: "confirmed",
  });
  assert.deepEqual(new Set(recipients), new Set([
    "customer-a",
    "chef-1",
    "chef-2",
    "waiter-1",
  ]));
  assert.equal(model.records.length, 4);
  assert.ok(model.records.every((record) =>
    record.type === "order_status_changed" &&
    record.previousStatus === "pending" &&
    record.newStatus === "confirmed" &&
    !Object.hasOwn(record, "email") &&
    !Object.hasOwn(record, "amountMinor")
  ));

  const reservationRecipients = await service.statusChanged({
    resourceType: "reservation",
    resourceId: "reservation-1",
    ownerId: "customer-a",
    previousStatus: "confirmed",
    newStatus: "cancelled",
  });
  assert.deepEqual(new Set(reservationRecipients), new Set([
    "customer-a",
    "manager-1",
    "waiter-1",
  ]));
});

test("notifications are idempotent on retries and unchanged states produce none", async () => {
  const model = createNotificationModel();
  const service = createNotificationService({
    Notification: model,
    userCollection: createUserCollection(),
  });
  const event = {
    resourceType: "payment",
    resourceId: "payment-1",
    ownerId: "customer-a",
    previousStatus: "pending",
    newStatus: "paid",
  };
  await service.statusChanged(event);
  const firstCount = model.records.length;
  await service.statusChanged(event);
  assert.equal(model.records.length, firstCount);
  assert.deepEqual(await service.statusChanged({
    ...event,
    previousStatus: "paid",
    newStatus: "paid",
  }), []);
  assert.equal(model.records.length, firstCount);
});

test("notification inbox is paginated, recipient-scoped, and supports read/unread updates", async () => {
  const { app, model } = createTestApp();
  await model.create({
    recipientId: "customer-a",
    eventKey: "order_status_changed:order-1:pending:confirmed",
    type: "order_status_changed",
    resourceType: "order",
    resourceId: "order-1",
    previousStatus: "pending",
    newStatus: "confirmed",
    isRead: false,
    readAt: null,
  });
  await model.create({
    recipientId: "customer-a",
    eventKey: "order_status_changed:order-2:pending:confirmed",
    type: "order_status_changed",
    resourceType: "order",
    resourceId: "order-2",
    previousStatus: "pending",
    newStatus: "confirmed",
    isRead: false,
    readAt: null,
  });
  await model.create({
    recipientId: "other-customer",
    eventKey: "payment_status_changed:payment-1:pending:paid",
    type: "payment_status_changed",
    resourceType: "payment",
    resourceId: "payment-1",
    previousStatus: "pending",
    newStatus: "paid",
    isRead: false,
    readAt: null,
  });

  await withServer(app, async (baseUrl) => {
    const firstPage = await fetch(`${baseUrl}/api/v1/notifications?page=1&limit=1`, {
      headers: headers(),
    });
    assert.equal(firstPage.status, 200);
    const firstBody = await firstPage.json();
    assert.equal(firstBody.data.notifications.length, 1);
    assert.deepEqual(firstBody.meta, { page: 1, limit: 1, total: 2, totalPages: 2 });
    assert.equal(Object.hasOwn(firstBody.data.notifications[0], "recipientId"), false);

    const otherRecipientList = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: headers("other-customer"),
    });
    const otherRecipientBody = await otherRecipientList.json();
    assert.equal(otherRecipientBody.meta.total, 1);
    assert.equal(otherRecipientBody.data.notifications[0].resourceId, "payment-1");

    const targetId = firstBody.data.notifications[0].id;
    const markedRead = await fetch(`${baseUrl}/api/v1/notifications/${targetId}/read`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ isRead: true }),
    });
    assert.equal(markedRead.status, 200);
    assert.equal((await markedRead.json()).data.notification.isRead, true);

    const unread = await fetch(`${baseUrl}/api/v1/notifications?isRead=false`, {
      headers: headers(),
    });
    assert.equal((await unread.json()).meta.total, 1);

    const markedUnread = await fetch(`${baseUrl}/api/v1/notifications/${targetId}/read`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ isRead: false }),
    });
    assert.equal(markedUnread.status, 200);
    assert.equal((await markedUnread.json()).data.notification.readAt, null);

    const crossRecipient = await fetch(
      `${baseUrl}/api/v1/notifications/${targetId}/read`,
      {
        method: "PATCH",
        headers: headers("other-customer"),
        body: JSON.stringify({ isRead: true }),
      },
    );
    assert.equal(crossRecipient.status, 404);

    const signedOut = await fetch(`${baseUrl}/api/v1/notifications`);
    assert.equal(signedOut.status, 401);
  });
});

test("failed order status mutations do not enqueue notifications", async () => {
  let notificationCount = 0;
  const service = createOrderService({
    Order: {
      findOneAndUpdate: async () => null,
      exists: async () => ({ _id: "order-1" }),
    },
    MenuItem: {},
    Table: {},
    taxRateBasisPoints: 500,
    notificationService: {
      async statusChanged() {
        notificationCount += 1;
      },
    },
  });
  await assert.rejects(
    service.updateStatus("order-1", {
      expectedStatus: "preparing",
      status: "ready",
      role: "chef",
    }),
    /Order status changed/,
  );
  assert.equal(notificationCount, 0);
});

test("successful order and reservation status changes notify the record owner", async () => {
  const orderNotifications = [];
  const orderService = createOrderService({
    Order: {
      findOneAndUpdate: async () => ({
        _id: "order-1",
        userId: "customer-a",
        status: "ready",
        lines: [],
        toObject() {
          return {
            _id: this._id,
            userId: this.userId,
            status: this.status,
            lines: this.lines,
          };
        },
      }),
    },
    MenuItem: {},
    Table: {},
    taxRateBasisPoints: 500,
    notificationService: {
      async statusChanged(event) {
        orderNotifications.push(event);
      },
    },
  });
  await orderService.updateStatus("order-1", {
    expectedStatus: "preparing",
    status: "ready",
    role: "chef",
  });
  assert.deepEqual(orderNotifications, [{
    resourceType: "order",
    resourceId: "order-1",
    ownerId: "customer-a",
    previousStatus: "preparing",
    newStatus: "ready",
  }]);

  const reservationId = "reservation-1";
  const reservation = {
    _id: reservationId,
    tableId: "table-1",
    userId: "customer-a",
    status: "confirmed",
    startsAt: new Date(Date.now() + 86400000),
    endsAt: new Date(Date.now() + 90000000),
    partySize: 2,
    notes: "",
  };
  const table = { _id: "table-1", label: "T1", capacity: 4 };
  const reservationNotifications = [];
  const reservationService = createReservationService({
    Reservation: {
      findById: () => ({
        session() { return this; },
        lean: async () => structuredClone(reservation),
      }),
      findOneAndUpdate: (_filter, update) => ({
        lean: async () => {
          Object.assign(reservation, update.$set);
          return structuredClone(reservation);
        },
      }),
    },
    Table: {
      findOneAndUpdate: (_filter, update) => ({
        lean: async () => {
          if (update.$inc) table.reservationRevision = (table.reservationRevision ?? 0) + 1;
          return structuredClone(table);
        },
      }),
      findById: () => ({
        select() { return this; },
        lean: async () => structuredClone(table),
      }),
    },
    runInTransaction: (operation) => operation({}),
    notificationService: {
      async statusChanged(event) {
        reservationNotifications.push(event);
      },
    },
  });
  await assert.rejects(reservationService.cancel(reservationId, {
    role: "customer",
    userId: "another-customer",
  }), /Reservation not found/);
  assert.equal(reservationNotifications.length, 0);
  await reservationService.cancel(reservationId, {
    role: "customer",
    userId: "customer-a",
  });
  assert.deepEqual(reservationNotifications[0], {
    resourceType: "reservation",
    resourceId: reservationId,
    ownerId: "customer-a",
    previousStatus: "confirmed",
    newStatus: "cancelled",
  });
});

test("payment status transitions notify once even when Stripe retries the event", async () => {
  const model = createNotificationModel();
  const notificationService = createNotificationService({
    Notification: model,
    userCollection: createUserCollection(),
  });
  const payment = {
    _id: "payment-1",
    orderId: "order-1",
    userId: "customer-a",
    amountMinor: 1200,
    currency: "usd",
    status: "pending",
    stripeSessionId: "session-1",
    stripePaymentIntentId: "",
  };
  const PaymentModel = {
    findById: () => ({ lean: async () => structuredClone(payment) }),
    findOneAndUpdate: async (filter, update) => {
      if (payment.status !== filter.status) return null;
      Object.assign(payment, update.$set);
      return structuredClone(payment);
    },
  };
  const order = { paymentStatus: "unpaid" };
  const service = createPaymentService({
    Order: {
      findByIdAndUpdate: async (_id, update) => {
        Object.assign(order, update.$set);
        return order;
      },
    },
    Payment: PaymentModel,
    StripeEvent: {
      async create() {},
    },
    notificationService,
  });
  const event = {
    id: "event-payment-paid",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "session-1",
        amount_total: 1200,
        currency: "usd",
        payment_status: "paid",
        payment_intent: "intent-1",
        metadata: {
          paymentId: "payment-1",
          orderId: "order-1",
          userId: "customer-a",
        },
      },
    },
  };
  await service.handleStripeEvent(event);
  await service.handleStripeEvent(event);
  assert.equal(payment.status, "paid");
  assert.equal(order.paymentStatus, "paid");
  assert.equal(model.records.length, 2);
  assert.ok(model.records.every((record) =>
    record.type === "payment_status_changed" &&
    record.previousStatus === "pending" &&
    record.newStatus === "paid"
  ));
});
