import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

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

function createCustomerDatabase(records) {
  let projection;
  const users = {
    countDocuments: async (filter) => filterRecords(records, filter).length,
    find(filter, options) {
      projection = options.projection;
      let offset = 0;
      let pageSize = records.length;
      const cursor = {
        sort() {
          return cursor;
        },
        skip(value) {
          offset = value;
          return cursor;
        },
        limit(value) {
          pageSize = value;
          return cursor;
        },
        async toArray() {
          return filterRecords(records, filter)
            .slice(offset, offset + pageSize)
            .map(({ email }) => ({ email }));
        },
      };
      return cursor;
    },
  };

  return {
    database: { collection: (name) => {
      assert.equal(name, "user");
      return users;
    } },
    getProjection: () => projection,
  };
}

function filterRecords(records, filter) {
  return records.filter((record) => {
    if (record.role !== filter.role) return false;
    if (!filter.email) return true;
    return new RegExp(filter.email.$regex, filter.email.$options).test(record.email);
  });
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role ? { user: { id: "test-user", role } } : null;
      },
    },
  };
}

const records = [
  { email: "alpha@example.com", role: "customer", password: "must-not-leak" },
  { email: "beta@example.com", role: "customer", password: "must-not-leak" },
  { email: "gamma@example.com", role: "customer", password: "must-not-leak" },
  { email: "staff@example.com", role: "manager", password: "must-not-leak" },
];

test("customer directory requires a signed-in manager or admin", async () => {
  const { database } = createCustomerDatabase(records);
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    database,
  });

  await withServer(app, async (baseUrl) => {
    const signedOut = await fetch(`${baseUrl}/api/v1/customers`);
    assert.equal(signedOut.status, 401);

    const forbidden = await fetch(`${baseUrl}/api/v1/customers`, {
      headers: { "x-test-role": "waiter" },
    });
    assert.equal(forbidden.status, 403);

    const manager = await fetch(`${baseUrl}/api/v1/customers`, {
      headers: { "x-test-role": "manager" },
    });
    assert.equal(manager.status, 200);
  });
});

test("customer list is paginated, searchable, role-filtered, and field-allowlisted", async () => {
  const { database, getProjection } = createCustomerDatabase(records);
  const app = createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    database,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/customers?page=2&limit=1`, {
      headers: { "x-test-role": "admin" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.customers, [{ email: "beta@example.com" }]);
    assert.deepEqual(body.meta, { page: 2, limit: 1, total: 3, totalPages: 3 });
    assert.deepEqual(getProjection(), { _id: 0, email: 1 });
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);

    const search = await fetch(
      `${baseUrl}/api/v1/customers?search=ALPHA%40EXAMPLE.COM`,
      { headers: { "x-test-role": "manager" } },
    );
    assert.deepEqual((await search.json()).data.customers, [
      { email: "alpha@example.com" },
    ]);

    const literalRegex = await fetch(
      `${baseUrl}/api/v1/customers?search=%2A`,
      { headers: { "x-test-role": "manager" } },
    );
    assert.deepEqual((await literalRegex.json()).data.customers, []);

    const invalidFilter = await fetch(`${baseUrl}/api/v1/customers?role=admin`, {
      headers: { "x-test-role": "manager" },
    });
    assert.equal(invalidFilter.status, 400);
  });
});
