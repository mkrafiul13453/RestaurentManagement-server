import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_ROLES,
  createAuth as createBetterAuth,
  rejectClientRoleInput,
} from "../src/auth/auth.js";
import { createApp } from "../src/app.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
function createAccounts() {
  return new Map([
    ["admin-1", {
    id: "admin-1",
    email: "admin@example.com",
    name: "Restora Admin",
    role: "admin",
    createdAt,
    password: "must-not-leak",
    token: "must-not-leak",
    }],
    ["user-1", {
    id: "user-1",
    email: "user@example.com",
    name: "Restaurant User",
    role: "customer",
    createdAt,
    password: "must-not-leak",
    token: "must-not-leak",
    }],
    ["user-2", {
    id: "user-2",
    email: "manager@example.com",
    name: "Restaurant Manager",
    role: "manager",
    createdAt,
    password: "must-not-leak",
    token: "must-not-leak",
    }],
  ]);
}

function createAuth(accounts) {
  return {
    api: {
      async getSession({ headers }) {
        const role = headers.get("x-test-role");
        if (!role) return null;
        const id = headers.get("x-test-user") ?? (role === "admin" ? "admin-1" : "user-1");
        return {
          user: {
            id,
            role,
            email: accounts.get(id)?.email ?? `${id}@example.com`,
          },
          session: { id: "test-session" },
        };
      },
      async listUsers({ query }) {
        const acceptedRoles = Array.isArray(query.filterValue)
          ? query.filterValue
          : [query.filterValue];
        const search = query.searchValue?.toLowerCase();
        const filtered = [...accounts.values()]
          .filter((user) => acceptedRoles.includes(user.role))
          .filter((user) => !query.role || user.role === query.role)
          .filter((user) => !search || user.email.toLowerCase().includes(search))
          .sort((left, right) => right.createdAt - left.createdAt);
        return {
          users: filtered.slice(query.offset, query.offset + query.limit),
          total: filtered.length,
        };
      },
      async getUser({ query }) {
        return accounts.get(query.id) ?? null;
      },
      async setRole({ body }) {
        const user = accounts.get(body.userId);
        if (!user) throw new Error("Missing test user");
        user.role = body.role;
        return { user };
      },
    },
  };
}

function createDatabase() {
  const audits = [];
  return {
    audits,
    collection(name) {
      if (name === "user") {
        return {
          countDocuments: async () => 0,
          find: () => ({
            sort() { return this; },
            skip() { return this; },
            limit() { return this; },
            toArray: async () => [],
          }),
        };
      }
      assert.equal(name, "staff_role_audits");
      return {
        async insertOne(record) {
          audits.push({ ...record });
          return { acknowledged: true };
        },
      };
    },
  };
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

function headers(role, userId = "admin-1") {
  return {
    "content-type": "application/json",
    "x-test-role": role,
    "x-test-user": userId,
  };
}

function createTestApp({ authHandler, auth: authOverride } = {}) {
  const accounts = createAccounts();
  const auth = authOverride ?? createAuth(accounts);
  const database = createDatabase();
  return {
    app: createApp({
      clientOrigin: "http://localhost:3000",
      auth,
      database,
      authHandler,
    }),
    database,
    accounts,
  };
}

test("staff API requires an authenticated admin for every route", async () => {
  const { app } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const signedOut = await fetch(`${baseUrl}/api/v1/staff`);
    assert.equal(signedOut.status, 401);

    for (const role of ["manager", "waiter", "chef", "cashier", "customer"]) {
      const response = await fetch(`${baseUrl}/api/v1/staff`, {
        headers: headers(role),
      });
      assert.equal(response.status, 403, `${role} must not list staff`);
    }

    const deniedChange = await fetch(`${baseUrl}/api/v1/staff/user-1/role`, {
      method: "PATCH",
      headers: headers("manager"),
      body: JSON.stringify({ expectedRole: "customer", role: "manager" }),
    });
    assert.equal(deniedChange.status, 403);
  });
});

test("staff directory paginates, searches, filters roles, and only returns safe fields", async () => {
  const { app } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/staff?page=1&limit=1&role=manager&search=MANAGER`, {
      headers: headers("admin"),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.staff, [{
      id: "user-2",
      name: "Restaurant Manager",
      email: "manager@example.com",
      role: "manager",
      createdAt: createdAt.toISOString(),
    }]);
    assert.deepEqual(body.meta, { page: 1, limit: 1, total: 1, totalPages: 1 });
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);

    const allRoles = await fetch(`${baseUrl}/api/v1/staff?page=1&limit=20`, {
      headers: headers("admin"),
    });
    assert.equal((await allRoles.json()).meta.total, 3);
  });
});

test("role changes reject invalid roles, self-changes, and stale role assignments", async () => {
  const { app, database, accounts } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const invalidRole = await fetch(`${baseUrl}/api/v1/staff/user-1/role`, {
      method: "PATCH",
      headers: headers("admin"),
      body: JSON.stringify({ expectedRole: "customer", role: "owner" }),
    });
    assert.equal(invalidRole.status, 400);

    const selfChange = await fetch(`${baseUrl}/api/v1/staff/admin-1/role`, {
      method: "PATCH",
      headers: headers("admin"),
      body: JSON.stringify({ expectedRole: "admin", role: "manager" }),
    });
    assert.equal(selfChange.status, 403);

    const staleRole = await fetch(`${baseUrl}/api/v1/staff/user-1/role`, {
      method: "PATCH",
      headers: headers("admin"),
      body: JSON.stringify({ expectedRole: "waiter", role: "chef" }),
    });
    assert.equal(staleRole.status, 409);
    assert.equal(accounts.get("user-1").role, "customer");
    assert.equal(database.audits.length, 0);

    const forgedActor = await fetch(`${baseUrl}/api/v1/staff/user-1/role`, {
      method: "PATCH",
      headers: headers("admin"),
      body: JSON.stringify({
        expectedRole: "customer",
        role: "manager",
        actorId: "user-1",
      }),
    });
    assert.equal(forgedActor.status, 400);
  });
});

test("role changes use Better Auth and persist actor, target, old role, new role, and timestamp", async () => {
  const { app, database, accounts } = createTestApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/staff/user-1/role`, {
      method: "PATCH",
      headers: headers("admin"),
      body: JSON.stringify({ expectedRole: "customer", role: "waiter" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.staff.id, "user-1");
    assert.equal(body.data.staff.role, "waiter");
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);

    assert.equal(accounts.get("user-1").role, "waiter");
    assert.equal(database.audits.length, 1);
    const [audit] = database.audits;
    assert.equal(audit.actorId, "admin-1");
    assert.equal(audit.actorEmail, "admin@example.com");
    assert.equal(audit.targetUserId, "user-1");
    assert.equal(audit.targetEmail, "user@example.com");
    assert.equal(audit.previousRole, "customer");
    assert.equal(audit.newRole, "waiter");
    assert.ok(audit.changedAt instanceof Date);
  });
});

test("role field is rejected from signup and profile-update payloads", () => {
  for (const payload of [
    { path: "/sign-up/email", body: { name: "Forged", role: "admin" } },
    { path: "/sign-up/email", body: { name: "Forged", data: { role: "admin" } } },
    { path: "/update-user", body: { role: "admin" } },
    { path: "/update-user", body: { data: { role: "admin" } } },
  ]) {
    assert.throws(
      () => rejectClientRoleInput(payload),
      (error) => error.body?.code === "ROLE_ASSIGNMENT_FORBIDDEN",
    );
  }
  assert.doesNotThrow(() => rejectClientRoleInput({
    path: "/sign-up/email",
    body: { name: "Customer", email: "customer@example.com" },
  }));
  assert.deepEqual(AUTH_ROLES, ["admin", "manager", "waiter", "chef", "cashier", "customer"]);
});

test("Better Auth config exposes supported admin APIs for role management", () => {
  const auth = createBetterAuth({
    database: {},
    mongoClient: {},
    config: {
      NODE_ENV: "test",
      betterAuthUrl: "http://localhost:5000",
      BETTER_AUTH_SECRET: "a-test-secret-that-is-at-least-thirty-two-characters",
      clientOrigin: "http://localhost:3000",
    },
  });
  assert.equal(typeof auth.api.listUsers, "function");
  assert.equal(typeof auth.api.getUser, "function");
  assert.equal(typeof auth.api.setRole, "function");
});

test("Better Auth authentication routes run the role-protection hook", async () => {
  const auth = createBetterAuth({
    database: {},
    mongoClient: {},
    config: {
      NODE_ENV: "test",
      betterAuthUrl: "http://localhost:5000",
      BETTER_AUTH_SECRET: "a-test-secret-that-is-at-least-thirty-two-characters",
      clientOrigin: "http://localhost:3000",
    },
  });
  const { app } = createTestApp({ auth });
  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/auth/ok`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const forgedSignup = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Forged",
        email: "forged@example.com",
        password: "a-long-test-password",
        role: "admin",
      }),
    });
    assert.equal(forgedSignup.status, 400);
    assert.equal((await forgedSignup.json()).code, "ROLE_ASSIGNMENT_FORBIDDEN");
  });
});

test("public Better Auth admin endpoints are blocked to prevent bypassing staff audit", async () => {
  let handlerCalls = 0;
  const authHandler = (_request, response) => {
    handlerCalls += 1;
    response.status(200).json({ success: true });
  };
  const { app } = createTestApp({ authHandler });
  await withServer(app, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/api/auth/admin/set-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-1", role: "admin" }),
    });
    assert.equal(blocked.status, 404);
    assert.equal(handlerCalls, 0);

    const allowed = await fetch(`${baseUrl}/api/auth/sign-in/email`);
    assert.equal(allowed.status, 200);
    assert.equal(handlerCalls, 1);
  });
});
