import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { io as createSocketClient } from "socket.io-client";
import { createApp } from "../src/app.js";
import { Order } from "../src/models/order.js";
import { createRealtimeServer } from "../src/realtime/socket-server.js";
import { calculateOrderPricing } from "../src/services/pricing-service.js";

const menuId = "000000000000000000000011";
const tableId = "000000000000000000000022";

function createModels() {
  const menuItems = [{
    _id: menuId,
    name: "Rice bowl",
    priceMinor: 1501,
    isAvailable: true,
  }];
  const orders = new Map();
  const tables = new Map([[
    tableId,
    { _id: tableId, label: "T1", status: "available", activeOrderId: null },
  ]]);
  let nextOrderId = 100;

  function query(getValue) {
    let offset = 0;
    let pageLimit = Infinity;
    let sortDirection = -1;
    return {
      sort(fields) {
        if (fields?.createdAt) sortDirection = fields.createdAt;
        return this;
      },
      skip(value) { offset = value; return this; },
      limit(value) { pageLimit = value; return this; },
      async lean() {
        const value = await getValue();
        return Array.isArray(value)
          ? value
            .sort((left, right) => sortDirection * (
              new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
            ))
            .slice(offset, offset + pageLimit)
            .map(copy)
          : value && copy(value);
      },
    };
  }

  const OrderModel = {
    records: orders,
    async create(input) {
      const inputs = Array.isArray(input) ? input : [input];
      const created = inputs.map((fields) => {
        const record = {
          ...fields,
          _id: String(nextOrderId++).padStart(24, "0"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        orders.set(record._id, record);
        return copy(record);
      });
      return Array.isArray(input) ? created : created[0];
    },
    countDocuments: async (filter) => filterOrders([...orders.values()], filter).length,
    find: (filter) => query(async () => filterOrders([...orders.values()], filter)),
    findById: (id) => query(async () => orders.get(String(id)) ?? null),
    async findOneAndUpdate(filter, update) {
      const record = orders.get(String(filter._id));
      if (!record || record.status !== filter.status) return null;
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return copy(record);
    },
    async exists({ _id }) {
      return orders.has(String(_id)) ? { _id } : null;
    },
  };

  const MenuItemModel = {
    find(filter) {
      return query(async () => menuItems.filter((item) =>
        filter._id.$in.includes(item._id) && item.isAvailable === filter.isAvailable,
      ));
    },
  };

  const TableModel = {
    records: tables,
    async findOneAndUpdate(filter, update) {
      const record = tables.get(String(filter._id));
      if (
        !record ||
        record.status !== filter.status ||
        (filter.$or && record.activeOrderId)
      ) return null;
      Object.assign(record, update.$set);
      return copy(record);
    },
    exists({ _id }) {
      return {
        session: async () => (tables.has(String(_id)) ? { _id } : null),
      };
    },
  };

  let transactionTail = Promise.resolve();
  const runInTransaction = (operation) => {
    const transaction = transactionTail.then(async () => {
      const orderSnapshot = new Map([...orders].map(([key, value]) => [key, copy(value)]));
      const tableSnapshot = new Map([...tables].map(([key, value]) => [key, copy(value)]));
      try {
        return await operation({});
      } catch (error) {
        orders.clear();
        for (const [key, value] of orderSnapshot) orders.set(key, value);
        tables.clear();
        for (const [key, value] of tableSnapshot) tables.set(key, value);
        throw error;
      }
    });
    transactionTail = transaction.catch(() => {});
    return transaction;
  };

  return {
    Order: OrderModel,
    MenuItem: MenuItemModel,
    Table: TableModel,
    orders,
    tables,
    runInTransaction,
  };
}

function copy(value) {
  return structuredClone(value);
}

function filterOrders(records, filter) {
  return records
    .filter((record) => (!filter.userId || record.userId === filter.userId))
    .filter((record) => (
      !filter.status ||
      (Array.isArray(filter.status.$in)
        ? filter.status.$in.includes(record.status)
        : record.status === filter.status)
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role
          ? { user: { id: headers.get("x-test-user") || "user-a", role } }
          : null;
      },
    },
  };
}

function createTestApp(models, options = {}) {
  return createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...models,
    taxRateBasisPoints: 500,
    taxRoundingPolicy: "half_up",
    ...options,
  });
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withRealtimeServer(models, run) {
  let io;
  const app = createTestApp(models, {
    publishOrderUpdate: (order) => io?.publishOrderUpdate(order),
  });
  const server = createServer(app);
  io = createRealtimeServer({
    server,
    auth: createAuth(),
    clientOrigin: "http://localhost:3000",
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => io.close(resolve));
  }
}

function connectSocket(baseUrl, role, userId = "user-a", options = {}) {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(baseUrl, {
      autoConnect: true,
      reconnection: options.reconnection ?? false,
      transports: ["websocket"],
      extraHeaders: {
        origin: options.origin ?? "http://localhost:3000",
        ...(role ? { "x-test-role": role } : {}),
        "x-test-user": userId,
      },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

function nextSocketEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function jsonHeaders(role, user = "user-a") {
  return {
    "content-type": "application/json",
    "x-test-role": role,
    "x-test-user": user,
  };
}

async function postOrder(baseUrl, role = "customer", body = {
  items: [{ menuItemId: menuId, quantity: 2 }],
}) {
  return fetch(`${baseUrl}/api/v1/orders`, {
    method: "POST",
    headers: jsonHeaders(role),
    body: JSON.stringify(body),
  });
}

test("pricing uses integer minor units and deterministic half-up tax", () => {
  const lines = [{ unitPriceMinor: 1501, quantity: 2 }];
  assert.deepEqual(calculateOrderPricing(lines, 500), {
    subtotalMinor: 3002,
    taxRateBasisPoints: 500,
    taxRoundingPolicy: "half_up",
    taxMinor: 150,
    discountMinor: 0,
    totalMinor: 3152,
  });
  assert.deepEqual(calculateOrderPricing(lines, 500), calculateOrderPricing(lines, 500));
  assert.equal(
    calculateOrderPricing([{ unitPriceMinor: 10, quantity: 1 }], 500).taxMinor,
    1,
  );
  assert.equal(
    calculateOrderPricing([{ unitPriceMinor: 9, quantity: 1 }], 500).taxMinor,
    0,
  );
  assert.throws(() => calculateOrderPricing(lines, -1), /Tax rate must be configured/);
});

test("order schema defines snapshots, status, timestamps, and indexes", async () => {
  const valid = new Order({
    userId: "user-a",
    lines: [{
      menuItemId: menuId,
      nameSnapshot: "Rice bowl",
      quantity: 1,
      unitPriceMinor: 1501,
      lineTotalMinor: 1501,
    }],
    subtotalMinor: 1501,
    taxRateBasisPoints: 500,
    taxRoundingPolicy: "half_up",
    taxMinor: 75,
    discountMinor: 0,
    totalMinor: 1576,
  });
  await valid.validate();
  assert.equal(valid.status, "pending");
  assert.equal(Order.schema.options.timestamps, true);
  assert.ok(Order.schema.indexes().some(([keys]) => keys.userId === 1));
  assert.ok(Order.schema.indexes().some(([keys]) => keys.status === 1));

  const invalid = new Order({
    userId: "user-a",
    lines: [],
    status: "in-kitchen",
    subtotalMinor: 1,
    taxRateBasisPoints: 500,
    taxRoundingPolicy: "half_up",
    taxMinor: 0,
    discountMinor: 0,
    totalMinor: 1,
  });
  await assert.rejects(invalid.validate());
});

test("order creation prices from stored menu data and never trusts owner or totals", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    const response = await postOrder(baseUrl);
    assert.equal(response.status, 201);
    const { order } = (await response.json()).data;
    assert.equal(order.userId, "user-a");
    assert.equal(order.lines[0].unitPriceMinor, 1501);
    assert.deepEqual(order.billing, {
      subtotalMinor: 3002,
      taxRateBasisPoints: 500,
      taxRoundingPolicy: "half_up",
      taxMinor: 150,
      discountMinor: 0,
      totalMinor: 3152,
    });

    const forged = await postOrder(baseUrl, "customer", {
      items: [{ menuItemId: menuId, quantity: 1 }],
      userId: "victim",
      totalMinor: 1,
    });
    assert.equal(forged.status, 400);

    const unavailable = await postOrder(baseUrl, "customer", {
      items: [{ menuItemId: "000000000000000000000099", quantity: 1 }],
    });
    assert.equal(unavailable.status, 409);
  });
});

test("customers only list and read their own orders", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    const ownResponse = await postOrder(baseUrl);
    const ownOrder = (await ownResponse.json()).data.order;
    const otherResponse = await postOrder(baseUrl, "customer", {
      items: [{ menuItemId: menuId, quantity: 1 }],
    });
    const otherOrder = (await otherResponse.json()).data.order;
    models.orders.get(otherOrder._id).userId = "user-b";

    const list = await fetch(`${baseUrl}/api/v1/orders`, {
      headers: jsonHeaders("customer"),
    });
    const listed = (await list.json()).data.orders;
    assert.deepEqual(listed.map((order) => order._id), [ownOrder._id]);

    const forbiddenDetail = await fetch(`${baseUrl}/api/v1/orders/${otherOrder._id}`, {
      headers: jsonHeaders("customer"),
    });
    assert.equal(forbiddenDetail.status, 404);
    const guest = await fetch(`${baseUrl}/api/v1/orders`);
    assert.equal(guest.status, 401);
  });
});

test("order lists paginate and legacy order documents remain readable without fabricated billing", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    await postOrder(baseUrl);
    await postOrder(baseUrl);
    const legacyId = "000000000000000000000077";
    models.orders.set(legacyId, {
      _id: legacyId,
      userId: "user-b",
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const page = await fetch(`${baseUrl}/api/v1/orders?page=2&limit=1`, {
      headers: jsonHeaders("manager"),
    });
    const pageBody = await page.json();
    assert.equal(page.status, 200);
    assert.equal(pageBody.data.orders.length, 1);
    assert.deepEqual(pageBody.meta, { page: 2, limit: 1, total: 3, totalPages: 3 });

    const detail = await fetch(`${baseUrl}/api/v1/orders/${legacyId}`, {
      headers: jsonHeaders("admin"),
    });
    const legacy = (await detail.json()).data.order;
    assert.equal(detail.status, 200);
    assert.equal(legacy.billing, null);
    assert.equal(models.orders.has(legacyId), true);
  });
});

test("status lifecycle authorizes transitions and gates inventory-dependent changes", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    const createdResponse = await postOrder(baseUrl);
    const order = (await createdResponse.json()).data.order;
    const patch = (role, expectedStatus, status) => fetch(
      `${baseUrl}/api/v1/orders/${order._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders(role),
        body: JSON.stringify({ expectedStatus, status }),
      },
    );

    assert.equal((await patch("chef", "pending", "confirmed")).status, 403);
    const confirmation = await patch("waiter", "pending", "confirmed");
    assert.equal(confirmation.status, 409);
    assert.equal((await confirmation.json()).error.code, "STOCK_LIFECYCLE_NOT_READY");
    assert.equal((await patch("waiter", "pending", "ready")).status, 409);

    const cancelledOrder = (await (await postOrder(baseUrl)).json()).data.order;
    const cancelRequest = (role) => fetch(
      `${baseUrl}/api/v1/orders/${cancelledOrder._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders(role),
        body: JSON.stringify({ expectedStatus: "pending", status: "cancelled" }),
      },
    );
    const races = await Promise.all([
      cancelRequest("waiter"),
      cancelRequest("manager"),
    ]);
    assert.deepEqual(races.map((response) => response.status).sort(), [200, 409]);

    const repeated = await fetch(
      `${baseUrl}/api/v1/orders/${cancelledOrder._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("waiter"),
        body: JSON.stringify({ expectedStatus: "cancelled", status: "pending" }),
      },
    );
    assert.equal(repeated.status, 409);

    const confirmedOrder = (await (await postOrder(baseUrl)).json()).data.order;
    models.orders.get(confirmedOrder._id).status = "confirmed";
    const startPreparation = await fetch(
      `${baseUrl}/api/v1/orders/${confirmedOrder._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("chef"),
        body: JSON.stringify({ expectedStatus: "confirmed", status: "preparing" }),
      },
    );
    assert.equal(startPreparation.status, 409);
    assert.equal((await startPreparation.json()).error.code, "STOCK_LIFECYCLE_NOT_READY");

    models.orders.get(confirmedOrder._id).status = "preparing";
    assert.equal((await fetch(
      `${baseUrl}/api/v1/orders/${confirmedOrder._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("chef"),
        body: JSON.stringify({ expectedStatus: "preparing", status: "ready" }),
      },
    )).status, 200);
    const completion = await fetch(
      `${baseUrl}/api/v1/orders/${confirmedOrder._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("cashier"),
        body: JSON.stringify({ expectedStatus: "ready", status: "completed" }),
      },
    );
    assert.equal(completion.status, 409);
    assert.equal((await completion.json()).error.code, "STOCK_LIFECYCLE_NOT_READY");
  });
});

test("table-backed order claims atomically and cancellation releases its table", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    const [first, second] = await Promise.all([
      postOrder(baseUrl, "waiter", {
        items: [{ menuItemId: menuId, quantity: 1 }],
        tableId,
      }),
      postOrder(baseUrl, "waiter", {
        items: [{ menuItemId: menuId, quantity: 1 }],
        tableId,
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    assert.equal(models.orders.size, 1);
    const created = (await (first.status === 201 ? first : second).json()).data.order;
    assert.equal(models.tables.get(tableId).status, "occupied");
    assert.equal(models.tables.get(tableId).activeOrderId, created._id);

    const manualRelease = await fetch(
      `${baseUrl}/api/v1/tables/${tableId}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("waiter"),
        body: JSON.stringify({ status: "available", expectedStatus: "occupied" }),
      },
    );
    assert.equal(manualRelease.status, 409);

    const cancel = await fetch(`${baseUrl}/api/v1/orders/${created._id}/status`, {
      method: "PATCH",
      headers: jsonHeaders("waiter"),
      body: JSON.stringify({ expectedStatus: "pending", status: "cancelled" }),
    });
    assert.equal(cancel.status, 200);
    assert.equal(models.tables.get(tableId).status, "available");
    assert.equal(models.tables.get(tableId).activeOrderId, null);
  });
});

test("kitchen queue is chef-only, paginated, filtered, and excludes inactive orders", async () => {
  const models = createModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    const first = (await (await postOrder(baseUrl)).json()).data.order;
    const second = (await (await postOrder(baseUrl)).json()).data.order;
    const inactive = (await (await postOrder(baseUrl)).json()).data.order;
    models.orders.get(first._id).status = "confirmed";
    models.orders.get(first._id).createdAt = "2026-01-01T10:00:00.000Z";
    models.orders.get(second._id).status = "preparing";
    models.orders.get(second._id).createdAt = "2026-01-01T11:00:00.000Z";
    models.orders.get(inactive._id).status = "pending";

    const request = (role, query = "") =>
      fetch(`${baseUrl}/api/v1/kitchen${query}`, { headers: jsonHeaders(role) });

    assert.equal((await request("admin")).status, 403);
    assert.equal((await request("manager")).status, 403);
    assert.equal((await request("waiter")).status, 403);
    assert.equal((await request("cashier")).status, 403);
    assert.equal((await request("customer")).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/kitchen`)).status, 401);

    const page = await request("chef", "?page=1&limit=1");
    const body = await page.json();
    assert.equal(page.status, 200);
    assert.deepEqual(body.data.orders.map((order) => order._id), [first._id]);
    assert.deepEqual(body.meta, { page: 1, limit: 1, total: 2, totalPages: 2 });
    assert.equal("userId" in body.data.orders[0], false);
    assert.equal("totalMinor" in body.data.orders[0], false);
    assert.deepEqual(body.data.orders[0].lines, [{ nameSnapshot: "Rice bowl", quantity: 2 }]);

    const filtered = await request("chef", "?status=preparing");
    assert.deepEqual((await filtered.json()).data.orders.map((order) => order._id), [second._id]);
    assert.equal((await request("chef", "?status=pending")).status, 400);
    assert.equal((await request("chef", "?limit=0")).status, 400);

    const ready = await fetch(`${baseUrl}/api/v1/orders/${second._id}/status`, {
      method: "PATCH",
      headers: jsonHeaders("chef"),
      body: JSON.stringify({ expectedStatus: "preparing", status: "ready" }),
    });
    assert.equal(ready.status, 200);
    const updated = (await ready.json()).data.order;
    assert.equal(updated.status, "ready");

    const chefOnlyAction = (await (await postOrder(baseUrl)).json()).data.order;
    models.orders.get(chefOnlyAction._id).status = "preparing";
    const managerReady = await fetch(
      `${baseUrl}/api/v1/orders/${chefOnlyAction._id}/status`,
      {
        method: "PATCH",
        headers: jsonHeaders("manager"),
        body: JSON.stringify({ expectedStatus: "preparing", status: "ready" }),
      },
    );
    assert.equal(managerReady.status, 403);
  });
});

test("authenticated sockets receive scoped read-only updates only after REST writes", async () => {
  const models = createModels();
  await withRealtimeServer(models, async (baseUrl) => {
    const createResponse = await postOrder(baseUrl, "customer", {
      items: [{ menuItemId: menuId, quantity: 1 }],
    });
    const order = (await createResponse.json()).data.order;
    models.orders.get(order._id).userId = "customer-b";
    models.orders.get(order._id).status = "preparing";

    await assert.rejects(connectSocket(baseUrl, null), /UNAUTHORIZED/);
    await assert.rejects(connectSocket(baseUrl, "chef", "staff-chef", {
      origin: "https://unapproved.example",
    }));
    const chef = await connectSocket(baseUrl, "chef");
    const manager = await connectSocket(baseUrl, "manager");
    const owner = await connectSocket(baseUrl, "customer", "customer-b", { reconnection: true });
    const otherCustomer = await connectSocket(baseUrl, "customer", "customer-a");

    const reconnected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket did not reconnect")), 3000);
      owner.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    owner.io.engine.close();
    await reconnected;

    let otherCustomerReceivedUpdate = false;
    let kitchenEvents = 0;
    let managerKitchenEvents = 0;
    chef.on("kitchen:order-updated", () => { kitchenEvents += 1; });
    manager.on("kitchen:order-updated", () => { managerKitchenEvents += 1; });
    otherCustomer.on("order:updated", () => { otherCustomerReceivedUpdate = true; });
    otherCustomer.emit("room:join", { room: "orders:user:customer-b" });
    chef.emit("order:status", { orderId: order._id, status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(models.orders.get(order._id).status, "preparing");
    const invalidTransition = await fetch(`${baseUrl}/api/v1/orders/${order._id}/status`, {
      method: "PATCH",
      headers: jsonHeaders("chef", "staff-chef"),
      body: JSON.stringify({ expectedStatus: "preparing", status: "completed" }),
    });
    assert.equal(invalidTransition.status, 409);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(kitchenEvents, 0);

    const kitchenEvent = nextSocketEvent(chef, "kitchen:order-updated");
    const staffEvent = nextSocketEvent(manager, "order:updated");
    const ownerEvent = nextSocketEvent(owner, "order:updated");
    const response = await fetch(`${baseUrl}/api/v1/orders/${order._id}/status`, {
      method: "PATCH",
      headers: jsonHeaders("chef", "staff-chef"),
      body: JSON.stringify({ expectedStatus: "preparing", status: "ready" }),
    });
    assert.equal(response.status, 200);

    const [kitchenUpdate, staffUpdate, ownerUpdate] = await Promise.all([
      kitchenEvent,
      staffEvent,
      ownerEvent,
    ]);
    assert.equal(kitchenUpdate.orderId, order._id);
    assert.equal(kitchenUpdate.status, "ready");
    assert.deepEqual(kitchenUpdate.items, [{ name: "Rice bowl", quantity: 1 }]);
    assert.equal("userId" in kitchenUpdate, false);
    assert.equal("billing" in kitchenUpdate, false);
    assert.equal("totalMinor" in kitchenUpdate, false);
    assert.deepEqual(staffUpdate, kitchenUpdate);
    assert.deepEqual(ownerUpdate, kitchenUpdate);
    assert.equal(kitchenEvents, 1);
    assert.equal(managerKitchenEvents, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(otherCustomerReceivedUpdate, false);

    for (const socket of [chef, manager, owner, otherCustomer]) socket.disconnect();
  });
});
