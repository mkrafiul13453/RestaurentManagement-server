import mongoose from "mongoose";
import { AppError } from "../utils/app-error.js";

export const TABLE_STATUSES = ["available", "occupied", "reserved"];

const allowedStatusTransitions = {
  available: ["reserved"],
  occupied: ["available"],
  reserved: ["available"],
};

function handleDuplicateLabel(error) {
  if (error?.code === 11000) {
    throw new AppError("A table with this label already exists", 409, "TABLE_LABEL_CONFLICT");
  }
  throw error;
}

function requireTable(table) {
  if (!table) throw new AppError("Table not found", 404, "NOT_FOUND");
  return table;
}

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

export function createTableService(Table, Reservation, runInTransaction = defaultRunInTransaction) {
  return {
    async list({ page, limit, status, search }) {
      const filter = {};
      if (status) filter.status = status;
      if (search) filter.label = { $regex: escapeRegex(search), $options: "i" };

      const [total, tables] = await Promise.all([
        Table.countDocuments(filter),
        Table.find(filter)
          .sort({ label: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);

      return {
        tables,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async getById(id) {
      return requireTable(await Table.findById(id).lean());
    },

    async create(fields) {
      try {
        return await Table.create({
          label: fields.label,
          capacity: fields.capacity,
          status: "available",
        });
      } catch (error) {
        handleDuplicateLabel(error);
      }
    },

    async update(id, fields) {
      try {
        if (Reservation) {
          return await runInTransaction(async (session) => {
            const table = await Table.findOneAndUpdate(
              { _id: id },
              { $inc: { reservationRevision: 1 } },
              { new: true, session },
            );
            requireTable(table);

            let oversizedReservationQuery = Reservation.findOne({
              tableId: id,
              status: "confirmed",
              partySize: { $gt: fields.capacity },
            });
            if (typeof oversizedReservationQuery.session === "function") {
              oversizedReservationQuery = oversizedReservationQuery.session(session);
            }
            if (await oversizedReservationQuery.select("_id").lean()) {
              throw new AppError(
                "Table capacity cannot be lower than an active reservation's party size",
                409,
                "TABLE_CAPACITY_CONFLICT",
              );
            }

            const updatedTable = await Table.findByIdAndUpdate(
              id,
              { $set: { label: fields.label, capacity: fields.capacity } },
              { new: true, runValidators: true, session },
            );
            return requireTable(updatedTable);
          });
        }

        const table = await Table.findByIdAndUpdate(
          id,
          { $set: { label: fields.label, capacity: fields.capacity } },
          { new: true, runValidators: true },
        );
        return requireTable(table);
      } catch (error) {
        handleDuplicateLabel(error);
      }
    },

    async updateStatus(id, { status, expectedStatus }) {
      if (!allowedStatusTransitions[expectedStatus]?.includes(status)) {
        throw new AppError(
          `Cannot change table status from ${expectedStatus} to ${status}`,
          409,
          "TABLE_STATUS_CONFLICT",
        );
      }

      const table = await Table.findOneAndUpdate(
        {
          _id: id,
          status: expectedStatus,
          $or: [{ activeOrderId: null }, { activeOrderId: { $exists: false } }],
        },
        { $set: { status, activeOrderId: null } },
        { new: true, runValidators: true },
      );
      if (table) return table;
      const exists = await Table.exists({ _id: id });
      if (!exists) throw new AppError("Table not found", 404, "NOT_FOUND");
      throw new AppError(
        "Table status changed. Refresh and try again.",
        409,
        "TABLE_STATUS_CONFLICT",
      );
    },

    async remove(id) {
      const removeTable = async (session) => {
        if (Reservation) {
          const locked = await Table.findOneAndUpdate(
            { _id: id },
            { $inc: { reservationRevision: 1 } },
            { new: true, session },
          );
          if (!locked) throw new AppError("Table not found", 404, "NOT_FOUND");
          let reservationQuery = Reservation.exists({ tableId: id, status: "confirmed" });
          if (typeof reservationQuery.session === "function") {
            reservationQuery = reservationQuery.session(session);
          }
          if (await reservationQuery) {
            throw new AppError(
              "Tables with active reservations cannot be deleted",
              409,
              "TABLE_HAS_RESERVATIONS",
            );
          }
        }

        const table = await Table.findOneAndDelete(
          {
            _id: id,
            status: "available",
            $or: [{ activeOrderId: null }, { activeOrderId: { $exists: false } }],
          },
          session ? { session } : undefined,
        );
        if (!table) {
          const exists = await Table.exists({ _id: id });
          if (!exists) throw new AppError("Table not found", 404, "NOT_FOUND");
          throw new AppError(
            "Occupied or reserved tables cannot be deleted",
            409,
            "TABLE_IN_USE",
          );
        }
        return table;
      };
      return Reservation ? runInTransaction(removeTable) : removeTable();
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
