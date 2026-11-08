import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Reservation } from "../src/models/reservation.js";

const tableId = "000000000000000000000001";

function copy(value) {
  return structuredClone(value);
}

function matches(record, filter) {
  if (filter._id && typeof filter._id === "object" && "$ne" in filter._id) {
    if (String(record._id) === String(filter._id.$ne)) return false;
  } else if (filter._id && String(record._id) !== String(filter._id)) {
    return false;
  }
  if (filter.tableId && String(record.tableId) !== String(filter.tableId)) return false;
  if (filter.userId && record.userId !== filter.userId) return false;
  if (filter.status && record.status !== filter.status) return false;
  if (filter.startsAt) {
    if (filter.startsAt.$lt && !(new Date(record.startsAt) < filter.startsAt.$lt)) return false;
    if (filter.startsAt.$gte && !(new Date(record.startsAt) >= filter.startsAt.$gte)) return false;
  }
  if (filter.endsAt?.$gt && !(new Date(record.endsAt) > filter.endsAt.$gt)) return false;
  return true;
}

function createModels() {
  const tables = new Map([
    [tableId, { _id: tableId, label: "T1", capacity: 4, status: "available", reservationRevision: 0 }],
    ["000000000000000000000002", { _id: "000000000000000000000002", label: "T2", capacity: 2, status: "available", reservationRevision: 0 }],
  ]);
  const reservations = new Map();
  let nextId = 10;

  function makeQuery(getResult) {
    let offset = 0;
    let pageLimit = Infinity;
    let sortBy = "startsAt";
    return {
      session() { return this; },
      select() { return this; },
      sort(fields) { sortBy = Object.keys(fields)[0]; return this; },
      skip(value) { offset = value; return this; },
      limit(value) { pageLimit = value; return this; },
      async lean() {
        const result = await getResult();
        if (!Array.isArray(result)) return result ? copy(result) : null;
        return result
          .sort((a, b) => new Date(a[sortBy]) - new Date(b[sortBy]))
          .slice(offset, offset + pageLimit)
          .map(copy);
      },
    };
  }

  const TableModel = {
    findOneAndUpdate(filter, update) {
      const table = tables.get(String(filter._id));
      if (!table) return makeQuery(async () => null);
      for (const [field, amount] of Object.entries(update.$inc ?? {})) {
        table[field] = (table[field] ?? 0) + amount;
      }
      return makeQuery(async () => table);
    },
    find(filter) {
      return makeQuery(async () => [...tables.values()].filter((table) => matches(table, filter)));
    },
    findById(id) { return makeQuery(async () => tables.get(String(id)) ?? null); },
  };

  const ReservationModel = {
    countDocuments: async (filter) => [...reservations.values()].filter((record) => matches(record, filter)).length,
    find(filter) {
      return makeQuery(async () => [...reservations.values()].filter((record) => matches(record, filter)));
    },
    findOne(filter) {
      return makeQuery(async () => [...reservations.values()].find((record) => matches(record, filter)) ?? null);
    },
    findById(id) { return makeQuery(async () => reservations.get(String(id)) ?? null); },
    async create(input) {
      return input.map((fields) => {
        const record = {
          ...copy(fields),
          _id: String(nextId++).padStart(24, "0"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        reservations.set(record._id, record);
        return { ...copy(record), toObject: () => copy(record) };
      });
    },
    findOneAndUpdate(filter, update) {
      return makeQuery(async () => {
        const record = reservations.get(String(filter._id));
        if (!record || !matches(record, filter)) return null;
        Object.assign(record, copy(update.$set), { updatedAt: new Date().toISOString() });
        return record;
      });
    },
  };

  let tail = Promise.resolve();
  const runInTransaction = (operation) => {
    const result = tail.then(async () => {
      const tableSnapshot = copy([...tables.entries()]);
      const reservationSnapshot = copy([...reservations.entries()]);
      try {
        return await operation({});
      } catch (error) {
        tables.clear();
        for (const [key, value] of tableSnapshot) tables.set(key, value);
        reservations.clear();
        for (const [key, value] of reservationSnapshot) reservations.set(key, value);
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  };

  return { Table: TableModel, Reservation: ReservationModel, tables, reservations, runInTransaction };
}

function createAuth() {
  return {
    api: {
      getSession: async ({ headers }) => {
        const role = headers.get("x-test-role");
        return role ? { user: { id: headers.get("x-test-user") || "user-a", role } } : null;
      },
    },
  };
}

function makeApp(models) {
  return createApp({
    clientOrigin: "http://localhost:3000",
    auth: createAuth(),
    ...models,
  });
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function headers(role, userId = "user-a") {
  return { "content-type": "application/json", "x-test-role": role, "x-test-user": userId };
}

function reservationBody({ tableId: id = tableId, startsAt, endsAt, partySize = 2, notes = "" } = {}) {
  const start = startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const end = endsAt ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
  return { tableId: id, startsAt: start, endsAt: end, partySize, notes };
}

function post(baseUrl, role, body, userId) {
  return fetch(`${baseUrl}/api/v1/reservations`, {
    method: "POST",
    headers: headers(role, userId),
    body: JSON.stringify(body),
  });
}

test("reservation schema has valid references, time range, status, timestamps, and indexes", async () => {
  const model = new Reservation({
    tableId,
    userId: "user-a",
    startsAt: new Date(Date.now() + 86400000),
    endsAt: new Date(Date.now() + 90000000),
    partySize: 2,
  });
  await model.validate();
  assert.equal(model.status, "confirmed");
  assert.equal(Reservation.schema.options.timestamps, true);
  assert.ok(Reservation.schema.indexes().some(([keys]) =>
    keys.tableId === 1 && keys.status === 1 && keys.startsAt === 1,
  ));
  assert.ok(Reservation.schema.indexes().some(([keys]) => keys.userId === 1));
});

test("reservation API enforces role permissions, required tables, capacity, and ownership", async () => {
  const models = createModels();
  await withServer(makeApp(models), async (baseUrl) => {
    assert.equal((await post(baseUrl, "chef", reservationBody())).status, 403);
    assert.equal((await post(baseUrl, "admin", reservationBody())).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/reservations`)).status, 401);

    const missingTable = await post(baseUrl, "customer", reservationBody({
      tableId: "000000000000000000000099",
    }));
    assert.equal(missingTable.status, 404);

    const tooMany = await post(baseUrl, "waiter", reservationBody({ partySize: 5 }));
    assert.equal(tooMany.status, 400);
    assert.equal((await tooMany.json()).error.code, "PARTY_EXCEEDS_CAPACITY");

    const create = await post(baseUrl, "customer", reservationBody());
    assert.equal(create.status, 201);
    const own = (await create.json()).data.reservation;
    assert.equal(own.userId, "user-a");

    const otherList = await fetch(`${baseUrl}/api/v1/reservations`, {
      headers: headers("customer", "user-b"),
    });
    assert.equal((await otherList.json()).meta.total, 0);

    const otherCancel = await fetch(`${baseUrl}/api/v1/reservations/${own._id}/cancel`, {
      method: "PATCH",
      headers: headers("customer", "user-b"),
      body: "{}",
    });
    assert.equal(otherCancel.status, 404);
    assert.equal(models.reservations.get(own._id).status, "confirmed");

    const adminList = await fetch(`${baseUrl}/api/v1/reservations`, {
      headers: headers("admin"),
    });
    const adminReservation = (await adminList.json()).data.reservations[0];
    assert.equal(adminList.status, 200);
    assert.equal("userId" in adminReservation, false);
    assert.equal("notes" in adminReservation, false);
    assert.equal((await (await fetch(`${baseUrl}/api/v1/reservations/${own._id}`, {
      headers: headers("admin"),
    })).json()).error.code, "FORBIDDEN");
  });
});

test("reservation overlap checks reject collisions, allow adjacent periods, and serialize concurrent bookings", async () => {
  const models = createModels();
  await withServer(makeApp(models), async (baseUrl) => {
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    startsAt.setUTCHours(23, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const firstBody = reservationBody({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });

    const concurrent = await Promise.all([
      post(baseUrl, "manager", firstBody),
      post(baseUrl, "waiter", firstBody),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    const conflictResponse = concurrent.find((response) => response.status === 409);
    assert.equal((await conflictResponse.json()).error.code, "RESERVATION_CONFLICT");
    assert.equal(models.reservations.size, 1);

    const adjacent = await post(baseUrl, "customer", reservationBody({
      startsAt: endsAt.toISOString(),
      endsAt: new Date(endsAt.getTime() + 60 * 60 * 1000).toISOString(),
    }));
    assert.equal(adjacent.status, 201);
    assert.equal(models.reservations.size, 2);

    const filtered = await fetch(
      `${baseUrl}/api/v1/reservations?date=${startsAt.toISOString().slice(0, 10)}&status=confirmed&tableId=${tableId}`,
      { headers: headers("manager") },
    );
    const filteredBody = await filtered.json();
    assert.equal(filtered.status, 200);
    assert.equal(filteredBody.meta.total, 1);
    assert.equal(filteredBody.data.reservations[0].table.label, "T1");

    const invalidRange = await post(baseUrl, "customer", reservationBody({
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
    }));
    assert.equal(invalidRange.status, 400);

    const invalidDateFilter = await fetch(`${baseUrl}/api/v1/reservations?date=2026-02-31`, {
      headers: headers("manager"),
    });
    assert.equal(invalidDateFilter.status, 400);
  });
});

test("reservation edits are conflict-safe and cancellation releases the reserved time", async () => {
  const models = createModels();
  await withServer(makeApp(models), async (baseUrl) => {
    const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const firstResponse = await post(baseUrl, "customer", reservationBody({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600000).toISOString(),
    }));
    const first = (await firstResponse.json()).data.reservation;
    const secondResponse = await post(baseUrl, "customer", reservationBody({
      tableId: "000000000000000000000002",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600000).toISOString(),
    }));
    const second = (await secondResponse.json()).data.reservation;

    const editCollision = await fetch(`${baseUrl}/api/v1/reservations/${second._id}`, {
      method: "PATCH",
      headers: headers("customer"),
      body: JSON.stringify(reservationBody({
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      })),
    });
    assert.equal(editCollision.status, 409);

    const forbiddenUpdate = await fetch(`${baseUrl}/api/v1/reservations/${first._id}`, {
      method: "PATCH",
      headers: headers("customer", "user-b"),
      body: JSON.stringify(reservationBody()),
    });
    assert.equal(forbiddenUpdate.status, 404);

    const cancellation = await fetch(`${baseUrl}/api/v1/reservations/${first._id}/cancel`, {
      method: "PATCH",
      headers: headers("customer"),
      body: "{}",
    });
    assert.equal(cancellation.status, 200);
    assert.equal((await cancellation.json()).data.reservation.status, "cancelled");

    const nowAvailable = await fetch(`${baseUrl}/api/v1/reservations/${second._id}`, {
      method: "PATCH",
      headers: headers("manager"),
      body: JSON.stringify(reservationBody({
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600000).toISOString(),
      })),
    });
    assert.equal(nowAvailable.status, 200);
    assert.equal((await nowAvailable.json()).data.reservation.table.label, "T1");
  });
});
