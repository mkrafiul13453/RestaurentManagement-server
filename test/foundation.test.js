import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readEnv } from "../src/config/env.js";
import { requireAuth, requireRole } from "../src/middleware/auth.js";
import { validate } from "../src/middleware/validate.js";
import { z } from "zod";

const baseEnv = {
  NODE_ENV: "test",
  PORT: "5000",
  CLIENT_ORIGIN: "http://localhost:3000",
  MONGODB_URI: "mongodb://127.0.0.1:27017/restora-test",
  BETTER_AUTH_SECRET: "a-test-secret-that-is-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "http://localhost:5000",
};

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

test("configuration requires usable database and auth settings", () => {
  const config = readEnv(baseEnv);
  assert.equal(config.clientOrigin, "http://localhost:3000");
  assert.equal(config.betterAuthUrl, "http://localhost:5000");
  assert.equal(config.IMGBB_API_KEY, "");
  assert.equal(config.STRIPE_SECRET_KEY, "");
  assert.equal(config.STRIPE_WEBHOOK_SECRET, "");
  assert.equal(readEnv({ ...baseEnv, IMGBB_API_KEY: "test-imgbb-key" }).IMGBB_API_KEY, "test-imgbb-key");
  assert.equal(config.ORDER_TAX_RATE_BASIS_POINTS, 500);
  assert.equal(config.ORDER_TAX_ROUNDING_POLICY, "half_up");
  assert.throws(() => readEnv({ ...baseEnv, BETTER_AUTH_SECRET: "short" }), /at least 32 characters/);
  assert.throws(() => readEnv({ ...baseEnv, CLIENT_ORIGIN: "http://localhost:3000/path" }), /without a path/);
  assert.throws(() => readEnv({ ...baseEnv, STRIPE_SECRET_KEY: "sk_test_example" }), /must be set together/);
  assert.throws(() => readEnv({
    ...baseEnv,
    STRIPE_SECRET_KEY: "sk_live_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
  }), /test-mode key/);
  assert.equal(readEnv({
    ...baseEnv,
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
  }).STRIPE_SECRET_KEY, "sk_test_example");
});

test("health endpoints use the documented success envelope and credentialed CORS", async () => {
  await withServer(createApp({ clientOrigin: baseEnv.CLIENT_ORIGIN }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: baseEnv.CLIENT_ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), baseEnv.CLIENT_ORIGIN);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.deepEqual(await response.json(), {
      success: true,
      data: { status: "ok" },
      message: "Restora API is running",
      error: null,
    });
  });
});

test("unknown API routes return a not-found envelope", async () => {
  await withServer(createApp({ clientOrigin: baseEnv.CLIENT_ORIGIN }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/missing`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "NOT_FOUND");
  });
});

test("malformed JSON receives a client error envelope", async () => {
  await withServer(createApp({ clientOrigin: baseEnv.CLIENT_ORIGIN }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_JSON");
  });
});

test("Express 5 auth catch-all runs before JSON body parsing", async () => {
  const app = createApp({
    clientOrigin: baseEnv.CLIENT_ORIGIN,
    authHandler: (request, response) => {
      response.json({ bodyWasParsed: request.body !== undefined });
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "customer@example.com" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { bodyWasParsed: false });
  });
});

test("session and role middleware enforce authentication and roles", async () => {
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: "staff-1", role: "manager" },
        session: { id: "session-1" },
      }),
    },
  };
  const request = { headers: {} };
  let error;
  await requireAuth(auth)(request, {}, (nextError) => {
    error = nextError;
  });
  assert.equal(error, undefined);
  assert.equal(request.user.role, "manager");

  let denied;
  requireRole("admin")(request, {}, (nextError) => {
    denied = nextError;
  });
  assert.equal(denied.statusCode, 403);
});

test("role middleware accepts case-insensitive database role values", async () => {
  const request = { user: { role: " Admin " } };
  let error;
  requireRole("admin")(request, {}, (nextError) => {
    error = nextError;
  });
  assert.equal(error, undefined);
});

test("validation middleware strips unknown fields and exposes parsed data", () => {
  const request = { body: { name: "Restora", role: "admin" } };
  let error;
  validate(z.object({ name: z.string() }))(request, {}, (nextError) => {
    error = nextError;
  });
  assert.equal(error, undefined);
  assert.deepEqual(request.validated.body, { name: "Restora" });
});
