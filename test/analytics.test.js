import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Order } from "../src/models/order.js";
import { Payment } from "../src/models/payment.js";
import { createAnalyticsService } from "../src/services/analytics-service.js";

function createAnalyticsModels({ empty = false } = {}) {
  const calls = { orders: [], payments: [] };
  const OrderModel = {
    aggregate(pipeline) {
      const call = { pipeline, options: null };
      calls.orders.push(call);
      return {
        option(options) {
          call.options = options;
          return Promise.resolve(empty ? [] : [{
            summary: [{
              totalOrders: 4,
              completedOrders: 2,
              cancelledOrders: 1,
              completedOrderValueMinor: 5000,
            }],
            daily: [
              { _id: "2026-03-08", orderCount: 3, completedOrders: 2, cancelledOrders: 1 },
            ],
          }]);
        },
      };
    },
  };
  const PaymentModel = {
    aggregate(pipeline) {
      const call = { pipeline, options: null };
      calls.payments.push(call);
      return {
        option(options) {
          call.options = options;
          if (empty) return Promise.resolve([]);
          if (pipeline.some((stage) => stage.$group?._id?.date)) {
            return Promise.resolve([
              { _id: { date: "2026-03-08", status: "paid" }, amountMinor: 4500, count: 2 },
              { _id: { date: "2026-03-08", status: "refunded" }, amountMinor: 1000, count: 1 },
            ]);
          }
          return Promise.resolve([
            { _id: "paid", amountMinor: 4500, count: 2 },
            { _id: "refunded", amountMinor: 1000, count: 1 },
            { _id: "pending", amountMinor: 2000, count: 2 },
            { _id: "failed", amountMinor: 700, count: 1 },
            { _id: "cancelled", amountMinor: 900, count: 1 },
          ]);
        },
      };
    },
  };
  return { Order: OrderModel, Payment: PaymentModel, calls };
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role ? { user: { id: "staff-1", role } } : null;
      },
    },
  };
}

function createTestApp(models) {
  return createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...models,
  });
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

test("analytics uses indexed timestamp ranges and accounts for fully refunded payments once", async () => {
  const models = createAnalyticsModels();
  const service = createAnalyticsService(models);
  const report = await service.getSalesReport({
    period: "daily",
    date: "2026-03-08",
    timeZone: "UTC",
  });

  assert.deepEqual(report.summary, {
    totalRevenueMinor: 4500,
    totalOrders: 4,
    completedOrders: 2,
    cancelledOrders: 1,
    averageOrderValueMinor: 2500,
    grossPaidMinor: 5500,
    refundedMinor: 1000,
  });
  assert.equal(report.payments.paid.count, 2);
  assert.equal(report.payments.pending.amountMinor, 2000);
  assert.equal(report.payments.failed.amountMinor, 700);
  assert.equal(report.payments.cancelled.amountMinor, 900);
  assert.deepEqual(report.trends[0], {
    date: "2026-03-08",
    orderCount: 3,
    completedOrders: 2,
    cancelledOrders: 1,
    revenueMinor: 4500,
  });
  assert.equal(models.calls.orders[0].pipeline[0].$match.createdAt.$gte.toISOString(), "2026-03-08T00:00:00.000Z");
  assert.equal(models.calls.orders[0].pipeline[0].$match.createdAt.$lt.toISOString(), "2026-03-09T00:00:00.000Z");
  assert.ok(models.calls.orders.every((call) => call.options.maxTimeMS === 5000));
  assert.ok(models.calls.payments.every((call) => call.options.maxTimeMS === 5000));
});

test("analytics calculates weekly/monthly date boundaries and IANA DST boundaries", async () => {
  const service = createAnalyticsService(createAnalyticsModels({ empty: true }));
  const weekly = await service.getSalesReport({
    period: "weekly",
    date: "2026-03-11",
    timeZone: "UTC",
  });
  assert.equal(weekly.range.from, "2026-03-09");
  assert.equal(weekly.range.to, "2026-03-15");
  assert.equal(weekly.trends.length, 7);

  const monthly = await service.getSalesReport({
    period: "monthly",
    date: "2026-02-14",
    timeZone: "UTC",
  });
  assert.equal(monthly.range.from, "2026-02-01");
  assert.equal(monthly.range.to, "2026-02-28");
  assert.equal(monthly.trends.length, 28);

  const dstDay = await service.getSalesReport({
    period: "daily",
    date: "2026-03-08",
    timeZone: "America/Los_Angeles",
  });
  assert.equal(dstDay.range.start, "2026-03-08T08:00:00.000Z");
  assert.equal(dstDay.range.endExclusive, "2026-03-09T07:00:00.000Z");
  assert.equal(dstDay.trends.length, 1);
});

test("custom analytics range is inclusive, bounded, and validates timezone and dates", async () => {
  const models = createAnalyticsModels();
  const service = createAnalyticsService(models);
  const custom = await service.getSalesReport({
    period: "custom",
    from: "2026-03-01",
    to: "2026-03-03",
    timeZone: "America/New_York",
  });
  assert.equal(custom.trends.length, 3);
  assert.equal(custom.range.start, "2026-03-01T05:00:00.000Z");
  assert.equal(custom.range.endExclusive, "2026-03-04T05:00:00.000Z");
  await assert.rejects(
    service.getSalesReport({ period: "custom", from: "2025-01-01", to: "2026-01-02" }),
    /cannot exceed 366 days/,
  );
  await assert.rejects(
    service.getSalesReport({ period: "custom", from: "2026-02-30", to: "2026-03-01" }),
    /valid from and to dates/,
  );
  await assert.rejects(
    service.getSalesReport({ period: "daily", date: "2026-03-08", timeZone: "Mars/Phobos" }),
    /valid IANA timezone/,
  );
  await assert.rejects(
    service.getSalesReport({ period: "daily", from: "2026-03-01", to: "2026-03-02" }),
    /only with a custom period/,
  );
});

test("analytics returns explicit zero values for empty ranges", async () => {
  const service = createAnalyticsService(createAnalyticsModels({ empty: true }));
  const report = await service.getSalesReport({
    period: "custom",
    from: "2026-01-01",
    to: "2026-01-02",
    timeZone: "UTC",
  });
  assert.equal(report.summary.totalRevenueMinor, 0);
  assert.equal(report.summary.totalOrders, 0);
  assert.equal(report.summary.averageOrderValueMinor, 0);
  assert.equal(report.payments.refunded.count, 0);
  assert.equal(report.trends.length, 2);
  assert.ok(report.trends.every((row) => row.revenueMinor === 0 && row.orderCount === 0));
});

test("analytics rejects aggregate amounts outside the safe integer range", async () => {
  const models = createAnalyticsModels();
  models.Payment.aggregate = (pipeline) => ({
    option() {
      return Promise.resolve(pipeline.some((stage) => stage.$group?._id?.date)
        ? []
        : [{ _id: "paid", amountMinor: Number.MAX_SAFE_INTEGER + 1, count: 1 }]);
    },
  });
  const service = createAnalyticsService(models);
  await assert.rejects(
    service.getSalesReport({ period: "daily", date: "2026-03-08", timeZone: "UTC" }),
    /supported integer range/,
  );
});

test("analytics API allows admin/manager only and ignores no client financial inputs", async () => {
  const models = createAnalyticsModels();
  const app = createTestApp(models);
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/analytics`)).status, 401);
    for (const role of ["customer", "chef", "waiter", "cashier"]) {
      assert.equal((await fetch(`${baseUrl}/api/v1/analytics`, {
        headers: { "x-test-role": role },
      })).status, 403);
    }

    const response = await fetch(
      `${baseUrl}/api/v1/analytics?period=daily&date=2026-03-08&timeZone=UTC`,
      { headers: { "x-test-role": "manager" } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.summary.totalRevenueMinor, 4500);

    const admin = await fetch(
      `${baseUrl}/api/v1/analytics?period=daily&date=2026-03-08&totalRevenueMinor=999999`,
      { headers: { "x-test-role": "admin" } },
    );
    assert.equal(admin.status, 400);
    assert.ok(models.calls.orders.length > 0);
  });
});

test("analytics schemas add compound createdAt/status indexes", () => {
  assert.ok(Order.schema.indexes().some(([keys]) =>
    keys.createdAt === 1 && keys.status === 1
  ));
  assert.ok(Payment.schema.indexes().some(([keys]) =>
    keys.createdAt === 1 && keys.status === 1
  ));
});
