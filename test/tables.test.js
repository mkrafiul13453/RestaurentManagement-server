import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Table } from "../src/models/table.js";

const tableId = "000000000000000000000001";

function createTableModel(initial = []) {
  const records = new Map(initial.map((record) => [record._id, { ...record }]));
  let nextId = 2;

  function makeQuery(getResult) {
    let offset = 0;
    let limit = Infinity;
    return {
      sort() {
        return this;
      },
      skip(value) {
        offset = value;
        return this;
      },
      limit(value) {
        limit = value;
        return this;
      },
      async lean() {
        const result = await getResult();
        return Array.isArray(result)
          ? result.slice(offset, offset + limit).map((record) => ({ ...record }))
          : result && { ...result };
      },
    };
  }

  return {
    records,
    countDocuments: async (filter) => filterRecords(records, filter).length,
    find: (filter) => makeQuery(async () => filterRecords(records, filter)),
    findById: (id) => makeQuery(async () => records.get(id) ?? null),
    async create(fields) {
      const record = {
        ...fields,
        _id: String(nextId++).padStart(24, "0"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.set(record._id, record);
      return { ...record };
    },
    async findByIdAndUpdate(id, update) {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return { ...record };
    },
    async findOneAndUpdate(filter, update) {
      const record = records.get(filter._id);
      if (record && update.$inc) {
        for (const [field, amount] of Object.entries(update.$inc)) {
          record[field] = (record[field] ?? 0) + amount;
        }
        return { ...record };
      }
      if (!record || record.status !== filter.status) return null;
      Object.assign(record, update.$set, { updatedAt: new Date().toISOString() });
      return { ...record };
    },
    async exists({ _id }) {
      return records.has(_id) ? { _id } : null;
    },
    async findOneAndDelete({ _id, status }) {
      const record = records.get(_id);
      if (!record || record.status !== status) return null;
      records.delete(_id);
      return { ...record };
    },
  };
}

function filterRecords(records, filter) {
  return [...records.values()].filter((record) => {
    if (filter.status && record.status !== filter.status) return false;
    if (filter.label && !new RegExp(filter.label.$regex, filter.label.$options).test(record.label)) {
      return false;
    }
    return true;
  }).sort((left, right) => left.label.localeCompare(right.label));
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

function createTestApp(model, Reservation) {
  return createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    Table: model,
    Reservation,
    ...(Reservation ? { runInTransaction: (operation) => operation({}) } : {}),
  });
}

test("table schema validates the documented fields, statuses, timestamps, and indexes", async () => {
  const valid = new Table({ label: "Patio 1", capacity: 4 });
  await valid.validate();
  assert.equal(valid.status, "available");
  assert.equal(Table.schema.options.timestamps, true);

  const invalid = new Table({ label: "Patio 2", capacity: 2, status: "cleaning" });
  await assert.rejects(invalid.validate(), /`cleaning` is not a valid enum value/);

  const indexes = Table.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.label === 1 && options.unique));
  assert.ok(indexes.some(([keys]) => keys.status === 1 && keys.label === 1));
});

test("table routes enforce authentication and the allowed role matrix", async () => {
  const app = createTestApp(createTableModel());
  await withServer(app, async (baseUrl) => {
    const signedOut = await fetch(`${baseUrl}/api/v1/tables`);
    assert.equal(signedOut.status, 401);

    for (const role of ["admin", "manager", "waiter"]) {
      const response = await fetch(`${baseUrl}/api/v1/tables`, {
        headers: { "x-test-role": role },
      });
      assert.equal(response.status, 200);
    }
    for (const role of ["chef", "cashier", "customer"]) {
      const response = await fetch(`${baseUrl}/api/v1/tables`, {
        headers: { "x-test-role": role },
      });
      assert.equal(response.status, 403);
    }
  });
});

test("table CRUD allowlists fields, validates input, paginates, and protects active tables", async () => {
  const model = createTableModel();
  const app = createTestApp(model);
  await withServer(app, async (baseUrl) => {
    const waiterHeaders = { "content-type": "application/json", "x-test-role": "waiter" };
    const deniedCreate = await fetch(`${baseUrl}/api/v1/tables`, {
      method: "POST",
      headers: waiterHeaders,
      body: JSON.stringify({ label: "Window 1", capacity: 2 }),
    });
    assert.equal(deniedCreate.status, 403);

    const invalidCreate = await fetch(`${baseUrl}/api/v1/tables`, {
      method: "POST",
      headers: { ...waiterHeaders, "x-test-role": "manager" },
      body: JSON.stringify({ label: "Window 1", capacity: 2, status: "occupied" }),
    });
    assert.equal(invalidCreate.status, 400);

    const created = await fetch(`${baseUrl}/api/v1/tables`, {
      method: "POST",
      headers: { ...waiterHeaders, "x-test-role": "manager" },
      body: JSON.stringify({ label: "Window 1", capacity: 2 }),
    });
    assert.equal(created.status, 201);
    const createdTable = (await created.json()).data.table;
    assert.equal(createdTable.status, "available");

    const patchWithExtra = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}`, {
      method: "PATCH",
      headers: { ...waiterHeaders, "x-test-role": "manager" },
      body: JSON.stringify({ label: "Window 1", capacity: 5, status: "occupied" }),
    });
    assert.equal(patchWithExtra.status, 400);

    const list = await fetch(`${baseUrl}/api/v1/tables?page=1&limit=1&search=window`, {
      headers: { "x-test-role": "admin" },
    });
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listBody.data.tables.length, 1);
    assert.deepEqual(listBody.meta, { page: 1, limit: 1, total: 1, totalPages: 1 });

    const directOccupancy = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}/status`, {
      method: "PATCH",
      headers: waiterHeaders,
      body: JSON.stringify({ status: "occupied", expectedStatus: "available" }),
    });
    assert.equal(directOccupancy.status, 409);

    const reserved = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}/status`, {
      method: "PATCH",
      headers: waiterHeaders,
      body: JSON.stringify({ status: "reserved", expectedStatus: "available" }),
    });
    assert.equal(reserved.status, 200);

    const protectedDelete = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}`, {
      method: "DELETE",
      headers: { "x-test-role": "manager" },
    });
    assert.equal(protectedDelete.status, 409);

    const released = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}/status`, {
      method: "PATCH",
      headers: waiterHeaders,
      body: JSON.stringify({ status: "available", expectedStatus: "reserved" }),
    });
    assert.equal(released.status, 200);

    const removed = await fetch(`${baseUrl}/api/v1/tables/${createdTable._id}`, {
      method: "DELETE",
      headers: { "x-test-role": "admin" },
    });
    assert.equal(removed.status, 204);
    assert.equal(model.records.has(createdTable._id), false);
  });
});

test("atomic status compare-and-set allows only one concurrent table status change", async () => {
  const model = createTableModel([{
    _id: tableId,
    label: "Main 1",
    capacity: 4,
    status: "available",
  }]);
  const app = createTestApp(model);
  await withServer(app, async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/v1/tables/${tableId}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-role": "waiter",
      },
      body: JSON.stringify({ status: "reserved", expectedStatus: "available" }),
    });

    const [first, second] = await Promise.all([request(), request()]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(model.records.get(tableId).status, "reserved");
  });
});

test("tables with active reservations cannot be deleted", async () => {
  const model = createTableModel([{
    _id: tableId,
    label: "T1",
    capacity: 4,
    status: "available",
  }]);
  const app = createTestApp(model, {
    findOne: (filter) => ({
      select() { return this; },
      async lean() {
        return filter.partySize &&
          filter.partySize.$gt < 3 &&
          filter.tableId === tableId &&
          filter.status === "confirmed"
          ? { _id: "reservation" }
          : null;
      },
    }),
    exists: async ({ tableId: reservedTableId, status }) =>
      reservedTableId === tableId && status === "confirmed" ? { _id: "reservation" } : null,
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/tables/${tableId}`, {
      method: "DELETE",
      headers: { "x-test-role": "admin" },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "TABLE_HAS_RESERVATIONS");
    assert.equal(model.records.has(tableId), true);
  });
});

test("table capacity cannot be reduced below an active reservation's party size", async () => {
  const model = createTableModel([{
    _id: tableId,
    label: "T1",
    capacity: 4,
    status: "available",
  }]);
  const Reservation = {
    findOne: (filter) => ({
      select() { return this; },
      async lean() {
        return filter.partySize.$gt < 3 ? { _id: "reservation" } : null;
      },
    }),
  };
  await withServer(createTestApp(model, Reservation), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/tables/${tableId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-role": "manager",
      },
      body: JSON.stringify({ label: "T1", capacity: 2 }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "TABLE_CAPACITY_CONFLICT");
    assert.equal(model.records.get(tableId).capacity, 4);
  });
});
