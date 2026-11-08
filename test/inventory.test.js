import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Ingredient, InventoryAdjustment } from "../src/models/ingredient.js";

const ingredientId = "000000000000000000000001";

function createInventoryModels(initial = []) {
  const ingredients = new Map(initial.map((record) => [record._id, { ...record }]));
  const adjustments = [];
  const stockUpdateSessions = new Set();
  let nextIngredientId = 2;
  let nextAdjustmentId = 1;

  function query(getValue) {
    let offset = 0;
    let limit = Infinity;
    let sort = {};
    return {
      sort(value) { sort = value; return this; },
      skip(value) { offset = value; return this; },
      limit(value) { limit = value; return this; },
      async lean() {
        let value = await getValue();
        if (Array.isArray(value)) {
          value = [...value].sort((left, right) => {
            for (const [field, direction] of Object.entries(sort)) {
              const comparison = String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
              if (comparison) return comparison * direction;
            }
            return 0;
          }).slice(offset, offset + limit);
          return value.map((record) => ({ ...record }));
        }
        return value && { ...value };
      },
    };
  }

  function matches(record, filter) {
    if (filter._id && record._id !== String(filter._id)) return false;
    if (filter.ingredientId && record.ingredientId !== String(filter.ingredientId)) return false;
    if (filter.isActive !== undefined && record.isActive !== filter.isActive) return false;
    if (filter.quantity !== undefined && record.quantity !== filter.quantity) return false;
    if (filter.adjustmentCount !== undefined && record.adjustmentCount !== filter.adjustmentCount) return false;
    if (filter.name && !new RegExp(filter.name.$regex, filter.name.$options).test(record.name)) return false;
    if (filter.$expr) {
      if (filter.$expr.$lte) {
        if (record.quantity > record.minimumStock) return false;
      } else {
        const delta = filter.$expr.$and[0].$gte[0].$add[1];
        const result = record.quantity + delta;
        if (result < 0 || result > Number.MAX_SAFE_INTEGER) return false;
      }
    }
    return true;
  }

  const IngredientModel = {
    records: ingredients,
    countDocuments: async (filter) => [...ingredients.values()].filter((item) => matches(item, filter)).length,
    find: (filter) => query(async () => [...ingredients.values()].filter((item) => matches(item, filter))),
    findById: (id) => query(async () => ingredients.get(String(id)) ?? null),
    async create(fields) {
      const record = {
        ...fields,
        _id: String(nextIngredientId++).padStart(24, "0"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      ingredients.set(record._id, record);
      return { ...record };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const record = [...ingredients.values()].find((item) => matches(item, filter));
      if (!record) return null;
      if (filter.$expr) {
        assert.ok(options.session, "stock changes must run in a transaction");
        stockUpdateSessions.add(options.session);
      }
      if (update.$inc) {
        for (const [field, amount] of Object.entries(update.$inc)) {
          record[field] = (record[field] ?? 0) + amount;
        }
      }
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return { ...record };
    },
    async exists({ _id }) {
      return ingredients.has(String(_id)) ? { _id } : null;
    },
  };
  const AdjustmentModel = {
    records: adjustments,
    countDocuments: async (filter) => adjustments.filter((item) => matches(item, filter)).length,
    find: (filter) => query(async () => adjustments.filter((item) => matches(item, filter))),
    async create([fields], { session } = {}) {
      assert.ok(session, "inventory adjustment and stock update must share a transaction");
      assert.ok(stockUpdateSessions.has(session), "audit and stock writes must share a transaction");
      const record = {
        ...fields,
        _id: String(nextAdjustmentId++).padStart(24, "0"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      adjustments.push(record);
      return [{ ...record }];
    },
  };
  return {
    Ingredient: IngredientModel,
    InventoryAdjustment: AdjustmentModel,
    ingredients,
    adjustments,
    stockUpdateSessions,
  };
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role ? { user: { id: headers.get("x-test-user") ?? "test-user", role } } : null;
      },
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

function createTestApp(models, runInTransaction = (operation) => operation({})) {
  return createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    Ingredient: models.Ingredient,
    InventoryAdjustment: models.InventoryAdjustment,
    runInTransaction,
  });
}

test("ingredient and adjustment schemas validate inventory data and indexes", async () => {
  const ingredient = new Ingredient({ name: "Rice", unit: "kg" });
  await ingredient.validate();
  assert.equal(ingredient.quantity, 0);
  assert.equal(ingredient.minimumStock, 0);
  assert.equal(ingredient.isActive, true);
  assert.equal(Ingredient.schema.options.timestamps, true);
  assert.ok(Ingredient.schema.indexes().some(([keys]) => keys.isActive === 1 && keys.name === 1));

  const adjustment = new InventoryAdjustment({
    ingredientId,
    delta: 2,
    unit: "kg",
    quantityAfter: 2,
    reason: "Opening count",
    actorId: "manager-1",
  });
  await adjustment.validate();
  assert.ok(InventoryAdjustment.schema.indexes().some(([keys]) =>
    keys.ingredientId === 1 && keys.createdAt === -1 && keys._id === -1,
  ));
});

test("ingredient API enforces the admin/manager write and chef read role matrix", async () => {
  const models = createInventoryModels();
  await withServer(createTestApp(models), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/ingredients`)).status, 401);
    for (const role of ["admin", "manager", "chef"]) {
      const response = await fetch(`${baseUrl}/api/v1/ingredients`, {
        headers: { "x-test-role": role },
      });
      assert.equal(response.status, 200);
    }
    for (const role of ["waiter", "cashier", "customer"]) {
      const response = await fetch(`${baseUrl}/api/v1/ingredients`, {
        headers: { "x-test-role": role },
      });
      assert.equal(response.status, 403);
    }

    const chefWrite = await fetch(`${baseUrl}/api/v1/ingredients`, {
      method: "POST",
      headers: { "x-test-role": "chef", "content-type": "application/json" },
      body: JSON.stringify({ name: "Rice", unit: "kg" }),
    });
    assert.equal(chefWrite.status, 403);
    assert.equal(models.ingredients.size, 0);

    const forgedStock = await fetch(`${baseUrl}/api/v1/ingredients`, {
      method: "POST",
      headers: { "x-test-role": "manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Rice", unit: "kg", quantity: 99 }),
    });
    assert.equal(forgedStock.status, 400);
    assert.equal(models.ingredients.size, 0);

    const created = await fetch(`${baseUrl}/api/v1/ingredients`, {
      method: "POST",
      headers: { "x-test-role": "manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Rice", unit: "kg", minimumStock: 2 }),
    });
    assert.equal(created.status, 201);
    const { data: { ingredient } } = await created.json();
    assert.equal(ingredient.quantity, 0);
    assert.equal(ingredient.minimumStock, 2);
    const detail = await fetch(`${baseUrl}/api/v1/inventory/${ingredient._id}`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.inventory.name, "Rice");

    const chefAdjustment = await fetch(`${baseUrl}/api/v1/inventory/${ingredient._id}/adjustments`, {
      method: "POST",
      headers: { "x-test-role": "chef", "content-type": "application/json" },
      body: JSON.stringify({ delta: 1, reason: "Count" }),
    });
    assert.equal(chefAdjustment.status, 403);
  });
});

test("inventory pagination, low-stock filtering, and adjustment history are available", async () => {
  const models = createInventoryModels([
    {
      _id: ingredientId,
      name: "Rice",
      unit: "kg",
      quantity: 1,
      minimumStock: 2,
      adjustmentCount: 1,
      isActive: true,
    },
    {
      _id: "000000000000000000000002",
      name: "Salt",
      unit: "kg",
      quantity: 10,
      minimumStock: 2,
      adjustmentCount: 0,
      isActive: true,
    },
  ]);
  models.adjustments.push({
    _id: "000000000000000000000001",
    ingredientId,
    delta: 1,
    unit: "kg",
    quantityAfter: 1,
    reason: "Opening count",
    actorId: "manager-1",
    createdAt: new Date().toISOString(),
  });

  await withServer(createTestApp(models), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/inventory?page=1&limit=1&lowStock=true`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.inventory.length, 1);
    assert.equal(body.data.inventory[0].name, "Rice");
    assert.deepEqual(body.meta, { page: 1, limit: 1, total: 1, totalPages: 1 });

    const history = await fetch(`${baseUrl}/api/v1/inventory/${ingredientId}/adjustments`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.equal(historyBody.data.adjustments[0].reason, "Opening count");
    assert.equal(historyBody.data.adjustments[0].actorId, "manager-1");

    const invalidQuery = await fetch(`${baseUrl}/api/v1/inventory?limit=1000`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal(invalidQuery.status, 400);
  });
});

test("atomic stock adjustments never go negative under concurrency and are audited", async () => {
  const models = createInventoryModels([{
    _id: ingredientId,
    name: "Rice",
    unit: "kg",
    quantity: 5,
    minimumStock: 1,
    adjustmentCount: 0,
    isActive: true,
  }]);
  const transactionSessions = [];
  const runInTransaction = (operation) => {
    const session = {};
    transactionSessions.push(session);
    return operation(session);
  };
  const app = createTestApp(models, runInTransaction);

  await withServer(app, async (baseUrl) => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(
      `${baseUrl}/api/v1/inventory/${ingredientId}/adjustments`,
      {
        method: "POST",
        headers: { "x-test-role": "admin", "x-test-user": "admin-7", "content-type": "application/json" },
        body: JSON.stringify({ delta: -1, reason: "Waste" }),
      },
    )));
    assert.equal(responses.filter((response) => response.status === 201).length, 5);
    assert.equal(responses.filter((response) => response.status === 409).length, 5);
    assert.equal(models.ingredients.get(ingredientId).quantity, 0);
    assert.equal(models.adjustments.length, 5);
    assert.equal(models.stockUpdateSessions.size, 5);
    assert.ok(models.adjustments.every(({ actorId, reason, unit }) =>
      actorId === "admin-7" && reason === "Waste" && unit === "kg",
    ));
    assert.equal(transactionSessions.length, 10);

    const invalid = await fetch(`${baseUrl}/api/v1/inventory/${ingredientId}/adjustments`, {
      method: "POST",
      headers: { "x-test-role": "manager", "content-type": "application/json" },
      body: JSON.stringify({ delta: -1, reason: "Overdraw" }),
    });
    assert.equal(invalid.status, 409);
    assert.equal(models.ingredients.get(ingredientId).quantity, 0);
  });
});

test("unit changes require untouched stock and archived ingredients retain their history", async () => {
  const models = createInventoryModels([{
    _id: ingredientId,
    name: "Rice",
    unit: "kg",
    quantity: 0,
    minimumStock: 0,
    adjustmentCount: 0,
    isActive: true,
  }]);
  models.adjustments.push({
    _id: "000000000000000000000001",
    ingredientId,
    delta: 1,
    unit: "kg",
    quantityAfter: 1,
    reason: "Opening count",
    actorId: "manager-1",
    createdAt: new Date().toISOString(),
  });
  await withServer(createTestApp(models), async (baseUrl) => {
    const updated = await fetch(`${baseUrl}/api/v1/ingredients/${ingredientId}`, {
      method: "PATCH",
      headers: { "x-test-role": "manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Rice", unit: "bag", minimumStock: 0 }),
    });
    assert.equal(updated.status, 200);
    assert.equal(models.ingredients.get(ingredientId).unit, "bag");

    models.ingredients.get(ingredientId).adjustmentCount = 1;
    const locked = await fetch(`${baseUrl}/api/v1/ingredients/${ingredientId}`, {
      method: "PATCH",
      headers: { "x-test-role": "manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Rice", unit: "kg", minimumStock: 0 }),
    });
    assert.equal(locked.status, 409);

    const archived = await fetch(`${baseUrl}/api/v1/ingredients/${ingredientId}`, {
      method: "DELETE",
      headers: { "x-test-role": "admin" },
    });
    assert.equal(archived.status, 204);
    assert.equal(models.ingredients.get(ingredientId).isActive, false);
    const history = await fetch(`${baseUrl}/api/v1/inventory/${ingredientId}/adjustments`, {
      headers: { "x-test-role": "chef" },
    });
    assert.equal((await history.json()).data.adjustments.length, 1);
  });
});
