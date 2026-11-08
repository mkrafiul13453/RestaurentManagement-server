import mongoose from "mongoose";
import { AppError } from "../utils/app-error.js";

const activeStatus = "confirmed";

async function defaultRunInTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function requireReservation(reservation) {
  if (!reservation) throw new AppError("Reservation not found", 404, "NOT_FOUND");
  return reservation;
}

function requireTable(table) {
  if (!table) throw new AppError("Table not found", 404, "INVALID_TABLE");
  return table;
}

function assertFutureRange(startsAt, endsAt) {
  if (!(startsAt instanceof Date) || !Number.isFinite(startsAt.getTime()) ||
      !(endsAt instanceof Date) || !Number.isFinite(endsAt.getTime())) {
    throw new AppError("Reservation dates must be valid", 400, "INVALID_RESERVATION_TIME");
  }
  if (startsAt <= new Date()) {
    throw new AppError("Reservation must start in the future", 400, "RESERVATION_NOT_FUTURE");
  }
  if (endsAt <= startsAt) {
    throw new AppError("Reservation end must be after its start", 400, "INVALID_RESERVATION_TIME");
  }
}

function overlapFilter({ tableId, startsAt, endsAt, excludeId }) {
  return {
    tableId,
    status: activeStatus,
    startsAt: { $lt: endsAt },
    endsAt: { $gt: startsAt },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };
}

export function createReservationService({
  Reservation,
  Table,
  runInTransaction = defaultRunInTransaction,
}) {
  async function serializeForAccess(reservation, role, userId) {
    if (role === "customer" && reservation.userId !== userId) {
      throw new AppError("Reservation not found", 404, "NOT_FOUND");
    }
    if (role === "admin") {
      const table = await Table.findById(reservation.tableId).select("label").lean();
      return {
        _id: reservation._id,
        table: table ? { _id: table._id, label: table.label } : null,
        startsAt: reservation.startsAt,
        endsAt: reservation.endsAt,
        partySize: reservation.partySize,
        status: reservation.status,
      };
    }
    const table = await Table.findById(reservation.tableId).select("label capacity").lean();
    return {
      ...reservation,
      table: table ? { _id: table._id, label: table.label, capacity: table.capacity } : null,
    };
  }

  async function acquireTableLocks(tableIds, session) {
    const tables = new Map();
    for (const tableId of [...new Set(tableIds.map(String))].sort()) {
      const table = await Table.findOneAndUpdate(
        { _id: tableId },
        { $inc: { reservationRevision: 1 } },
        { new: true, session },
      ).lean();
      tables.set(tableId, requireTable(table));
    }
    return tables;
  }

  async function assertNoOverlap({ tableId, startsAt, endsAt, excludeId, session }) {
    let query = Reservation.findOne(overlapFilter({ tableId, startsAt, endsAt, excludeId }));
    if (session) query = query.session(session);
    const existing = await query.select("_id").lean();
    if (existing) {
      throw new AppError(
        "This table already has a reservation during that time",
        409,
        "RESERVATION_CONFLICT",
      );
    }
  }

  return {
    async availableTables() {
      const tables = await Table.find({})
        .select("label capacity")
        .sort({ label: 1 })
        .lean();
      return tables.map(({ _id, label, capacity }) => ({ _id, label, capacity }));
    },

    async list({ role, userId, page, limit, date, status, tableId }) {
      const filter = {};
      if (role === "customer") filter.userId = userId;
      if (status) filter.status = status;
      if (tableId) filter.tableId = tableId;
      if (date) {
        const startsAt = new Date(`${date}T00:00:00.000Z`);
        const endsAt = new Date(`${date}T00:00:00.000Z`);
        endsAt.setUTCDate(endsAt.getUTCDate() + 1);
        filter.startsAt = { $gte: startsAt, $lt: endsAt };
      }

      const [total, reservations] = await Promise.all([
        Reservation.countDocuments(filter),
        Reservation.find(filter)
          .sort({ startsAt: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      const records = await Promise.all(
        reservations.map((reservation) => serializeForAccess(reservation, role, userId)),
      );
      return {
        reservations: records,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async getById(id, { role, userId }) {
      const reservation = requireReservation(await Reservation.findById(id).lean());
      if (role === "admin") {
        throw new AppError("Administrators can view reservation summaries only", 403, "FORBIDDEN");
      }
      return serializeForAccess(reservation, role, userId);
    },

    async create(fields, { role, userId }) {
      const startsAt = new Date(fields.startsAt);
      const endsAt = new Date(fields.endsAt);
      assertFutureRange(startsAt, endsAt);
      return runInTransaction(async (session) => {
        const table = (await acquireTableLocks([fields.tableId], session)).get(String(fields.tableId));
        if (fields.partySize > table.capacity) {
          throw new AppError("Party size exceeds the selected table capacity", 400, "PARTY_EXCEEDS_CAPACITY");
        }
        await assertNoOverlap({ tableId: table._id, startsAt, endsAt, session });
        const reservation = await Reservation.create([{
          tableId: table._id,
          userId,
          startsAt,
          endsAt,
          partySize: fields.partySize,
          notes: fields.notes ?? "",
          status: activeStatus,
        }], { session });
        const created = typeof reservation[0].toObject === "function"
          ? reservation[0].toObject()
          : reservation[0];
        return serializeForAccess(created, role, userId);
      });
    },

    async update(id, fields, { role, userId }) {
      if (role === "admin") {
        throw new AppError("Administrators have read-only reservation access", 403, "FORBIDDEN");
      }
      const startsAt = new Date(fields.startsAt);
      const endsAt = new Date(fields.endsAt);
      assertFutureRange(startsAt, endsAt);
      return runInTransaction(async (session) => {
        const current = requireReservation(await Reservation.findById(id).session(session).lean());
        if (role === "customer" && current.userId !== userId) {
          throw new AppError("Reservation not found", 404, "NOT_FOUND");
        }
        if (current.status !== activeStatus) {
          throw new AppError("Only active reservations can be updated", 409, "RESERVATION_NOT_ACTIVE");
        }

        const tableId = fields.tableId ?? String(current.tableId);
        const lockedTables = await acquireTableLocks([current.tableId, tableId], session);
        const table = lockedTables.get(String(tableId));
        if (fields.partySize > table.capacity) {
          throw new AppError("Party size exceeds the selected table capacity", 400, "PARTY_EXCEEDS_CAPACITY");
        }
        await assertNoOverlap({ tableId: table._id, startsAt, endsAt, excludeId: current._id, session });
        const reservation = await Reservation.findOneAndUpdate(
          { _id: current._id, status: activeStatus },
          {
            $set: {
              tableId: table._id,
              startsAt,
              endsAt,
              partySize: fields.partySize,
              notes: fields.notes ?? "",
            },
          },
          { new: true, runValidators: true, session },
        ).lean();
        return serializeForAccess(requireReservation(reservation), role, userId);
      });
    },

    async cancel(id, { role, userId }) {
      if (role === "admin") {
        throw new AppError("Administrators have read-only reservation access", 403, "FORBIDDEN");
      }
      return runInTransaction(async (session) => {
        const current = requireReservation(await Reservation.findById(id).session(session).lean());
        if (role === "customer" && current.userId !== userId) {
          throw new AppError("Reservation not found", 404, "NOT_FOUND");
        }
        if (current.status !== activeStatus) {
          throw new AppError("Reservation is already cancelled", 409, "RESERVATION_NOT_ACTIVE");
        }
        await acquireTableLocks([current.tableId], session);
        const reservation = await Reservation.findOneAndUpdate(
          { _id: current._id, status: activeStatus },
          { $set: { status: "cancelled" } },
          { new: true, runValidators: true, session },
        ).lean();
        return serializeForAccess(requireReservation(reservation), role, userId);
      });
    },
  };
}
