import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Review } from "../src/models/review.js";

const orderA = "000000000000000000000001";
const orderB = "000000000000000000000002";
const orderC = "000000000000000000000003";
const orderD = "000000000000000000000004";

function createModels() {
  const orders = new Map([
    [orderA, { _id: orderA, userId: "customer-a", status: "completed" }],
    [orderB, { _id: orderB, userId: "customer-a", status: "pending" }],
    [orderC, { _id: orderC, userId: "customer-b", status: "completed" }],
    [orderD, { _id: orderD, userId: "customer-a", status: "completed" }],
  ]);
  const reviews = [];
  let nextId = 1;
  const ReviewModel = {
    records: reviews,
    async countDocuments(filter) {
      return reviews.filter((review) => matches(review, filter)).length;
    },
    find(filter) {
      let offset = 0;
      let limit = Infinity;
      return {
        sort() { return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async lean() {
          return reviews
            .filter((review) => matches(review, filter))
            .slice()
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(offset, offset + limit)
            .map((review) => structuredClone(review));
        },
      };
    },
    async create(fields) {
      if (reviews.some((review) =>
        review.userId === fields.userId && review.orderId === fields.orderId
      )) {
        const error = new Error("duplicate review");
        error.code = 11000;
        throw error;
      }
      const review = {
        ...fields,
        _id: String(nextId++).padStart(24, "0"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      reviews.push(review);
      return structuredClone(review);
    },
  };
  const OrderModel = {
    findById(id) {
      return { lean: async () => structuredClone(orders.get(String(id)) ?? null) };
    },
  };
  return { Order: OrderModel, Review: ReviewModel, orders, reviews };
}

function matches(review, filter) {
  return review.userId === filter.userId &&
    (!filter.orderId || filter.orderId.$in.includes(review.orderId));
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        if (!role) return null;
        return {
          user: {
            id: headers.get("x-test-user") ?? "customer-a",
            role,
          },
        };
      },
    },
  };
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

function createTestApp() {
  const models = createModels();
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    Order: models.Order,
    Review: models.Review,
  });
  return { app, ...models };
}

function customerHeaders(userId = "customer-a") {
  return {
    "content-type": "application/json",
    "x-test-role": "customer",
    "x-test-user": userId,
  };
}

test("review schema has a unique customer/order index and validates rating and content", async () => {
  const uniqueIndex = Review.schema.indexes().find(([fields, options]) =>
    fields.userId === 1 && fields.orderId === 1 && options.unique === true
  );
  assert.ok(uniqueIndex);
  assert.equal(Review.schema.path("rating").options.min, 1);
  assert.equal(Review.schema.path("rating").options.max, 5);
  assert.equal(Review.schema.path("text").options.minlength, 10);
  assert.equal(Review.schema.path("text").options.maxlength, 1000);
  const validReview = new Review({
    userId: "customer-a",
    orderId: orderA,
    rating: 5,
    text: "Excellent food and service.",
  });
  await validReview.validate();
  for (const invalid of [
    { rating: 0, text: "This review text is long enough." },
    { rating: 6, text: "This review text is long enough." },
    { rating: 2.5, text: "This review text is long enough." },
    { rating: 4, text: "short" },
    { rating: 4, text: `1234567890\u0001` },
  ]) {
    const invalidReview = new Review({
      userId: "customer-a",
      orderId: orderA,
      ...invalid,
    });
    await assert.rejects(invalidReview.validate());
  }
});

test("only an authenticated customer can list and create reviews", async () => {
  const { app } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const signedOut = await fetch(`${baseUrl}/api/v1/reviews`);
    assert.equal(signedOut.status, 401);

    const nonCustomer = await fetch(`${baseUrl}/api/v1/reviews`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal(nonCustomer.status, 403);
  });
});

test("customers can review only their own completed orders", async () => {
  const { app, reviews } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const valid = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders(),
      body: JSON.stringify({ orderId: orderA, rating: 5, text: "Excellent food and service." }),
    });
    assert.equal(valid.status, 201);
    const body = await valid.json();
    assert.equal(body.data.review.orderId, orderA);
    assert.equal(Object.hasOwn(body.data.review, "userId"), false);
    assert.equal(reviews[0].userId, "customer-a");

    const otherCustomer = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders("customer-b"),
      body: JSON.stringify({ orderId: orderA, rating: 4, text: "A nice dinner overall." }),
    });
    assert.equal(otherCustomer.status, 404);

    const incomplete = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders(),
      body: JSON.stringify({ orderId: orderB, rating: 4, text: "This order is not finished." }),
    });
    assert.equal(incomplete.status, 409);

    const forgedOwner = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders(),
      body: JSON.stringify({
        orderId: orderC,
        userId: "customer-b",
        rating: 4,
        text: "A forged customer review.",
      }),
    });
    assert.equal(forgedOwner.status, 400);
    assert.equal(reviews.length, 1);
  });
});

test("review submission validates rating and review content", async () => {
  const { app, reviews } = createTestApp();
  await withServer(app, async (baseUrl) => {
    for (const payload of [
      { orderId: orderA, rating: 0, text: "A valid length of text." },
      { orderId: orderA, rating: 6, text: "A valid length of text." },
      { orderId: orderA, rating: 3.5, text: "A valid length of text." },
      { orderId: orderA, rating: 4, text: "   " },
      { orderId: orderA, rating: 4, text: "1234567890" + "\u0001" },
      { orderId: orderA, rating: 4, text: "short" },
      { orderId: orderA, rating: 4, text: "x".repeat(1001) },
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/reviews`, {
        method: "POST",
        headers: customerHeaders(),
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(reviews.length, 0);
  });
});

test("unique customer/order constraint prevents duplicate reviews", async () => {
  const { app, reviews } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const payload = JSON.stringify({
      orderId: orderA,
      rating: 4,
      text: "The meal was tasty and arrived warm.",
    });
    const first = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders(),
      body: payload,
    });
    const duplicate = await fetch(`${baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: customerHeaders(),
      body: payload,
    });
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, "REVIEW_ALREADY_EXISTS");
    assert.equal(reviews.length, 1);
  });
});

test("review history is paginated, scoped to the session user, and can be filtered to displayed orders", async () => {
  const { app } = createTestApp();
  await withServer(app, async (baseUrl) => {
    for (const [userId, orderId, text] of [
      ["customer-a", orderA, "Excellent meal from the kitchen."],
      ["customer-a", orderD, "Another excellent customer meal."],
      ["customer-b", orderC, "This other customer's review."],
    ]) {
      const created = await fetch(`${baseUrl}/api/v1/reviews`, {
        method: "POST",
        headers: customerHeaders(userId),
        body: JSON.stringify({ orderId, rating: 5, text }),
      });
      assert.equal(created.status, 201);
    }

    const response = await fetch(
      `${baseUrl}/api/v1/reviews?page=1&limit=1&orderIds=${orderA}%2C${orderC}%2C${orderD}`,
      { headers: customerHeaders() },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.reviews.length, 1);
    assert.ok([orderA, orderD].includes(body.data.reviews[0].orderId));
    assert.deepEqual(body.meta, { page: 1, limit: 1, total: 2, totalPages: 2 });
    assert.equal(JSON.stringify(body).includes("other customer's"), false);
    const secondPage = await fetch(
      `${baseUrl}/api/v1/reviews?page=2&limit=1`,
      { headers: customerHeaders() },
    );
    assert.equal((await secondPage.json()).data.reviews.length, 1);
  });
});
