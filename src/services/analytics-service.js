import { AppError } from "../utils/app-error.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const periods = ["daily", "weekly", "monthly", "custom"];

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function dateString({ year, month, day }) {
  return `${year}-${month}-${day}`;
}

function addCalendarDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstOfNextMonth(value) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function zonedMidnightToUtc(value, timeZone) {
  const [year, month, day] = value.split("-").map(Number);
  const targetWallTime = Date.UTC(year, month - 1, day);
  let timestamp = targetWallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    const representedWallTime = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const difference = targetWallTime - representedWallTime;
    timestamp += difference;
    if (difference === 0) break;
  }
  return new Date(timestamp);
}

function resolveDateRange({ period, date, from, to, timeZone }) {
  if (!periods.includes(period)) {
    throw new AppError("Period must be daily, weekly, monthly, or custom", 400, "INVALID_ANALYTICS_PERIOD");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new AppError("Timezone must be a valid IANA timezone", 400, "INVALID_ANALYTICS_TIMEZONE");
  }

  if (period === "custom") {
    if (!isValidDate(from) || !isValidDate(to)) {
      throw new AppError("Custom ranges require valid from and to dates", 400, "INVALID_ANALYTICS_RANGE");
    }
    if (from > to) {
      throw new AppError("The from date must not be after the to date", 400, "INVALID_ANALYTICS_RANGE");
    }
    const endExclusive = addCalendarDays(to, 1);
    const days = (Date.parse(`${endExclusive}T00:00:00.000Z`) -
      Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS;
    if (days > MAX_RANGE_DAYS) {
      throw new AppError(`Date range cannot exceed ${MAX_RANGE_DAYS} days`, 400, "ANALYTICS_RANGE_TOO_LARGE");
    }
    return {
      startDate: from,
      endDate: to,
      start: zonedMidnightToUtc(from, timeZone),
      end: zonedMidnightToUtc(endExclusive, timeZone),
    };
  }

  if (from !== undefined || to !== undefined) {
    throw new AppError("Use from and to only with a custom period", 400, "INVALID_ANALYTICS_RANGE");
  }
  if (date !== undefined && !isValidDate(date)) {
    throw new AppError("Date must be a valid calendar date", 400, "INVALID_ANALYTICS_DATE");
  }
  const selectedDate = date ?? dateString(datePartsInZone(new Date(), timeZone));
  let startDate = selectedDate;
  let endExclusive;
  if (period === "daily") {
    endExclusive = addCalendarDays(startDate, 1);
  } else if (period === "weekly") {
    const day = new Date(`${selectedDate}T00:00:00.000Z`).getUTCDay();
    startDate = addCalendarDays(selectedDate, -((day + 6) % 7));
    endExclusive = addCalendarDays(startDate, 7);
  } else {
    startDate = `${selectedDate.slice(0, 7)}-01`;
    endExclusive = firstOfNextMonth(selectedDate);
  }
  return {
    startDate,
    endDate: addCalendarDays(endExclusive, -1),
    start: zonedMidnightToUtc(startDate, timeZone),
    end: zonedMidnightToUtc(endExclusive, timeZone),
  };
}

function emptyDay(startDate, index) {
  return {
    date: addCalendarDays(startDate, index),
    orderCount: 0,
    completedOrders: 0,
    cancelledOrders: 0,
    revenueMinor: 0,
  };
}

function safeAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(
      "Analytics amount exceeds the supported integer range",
      500,
      "ANALYTICS_AMOUNT_OUT_OF_RANGE",
    );
  }
  return value;
}

export function createAnalyticsService({ Order, Payment }) {
  return {
    async getSalesReport({ period, date, from, to, timeZone = "UTC" }) {
      const range = resolveDateRange({ period, date, from, to, timeZone });
      const days = (
        Date.parse(`${addCalendarDays(range.endDate, 1)}T00:00:00.000Z`) -
        Date.parse(`${range.startDate}T00:00:00.000Z`)
      ) / DAY_MS;
      const [orderResult, paymentRows, paymentDailyRows] = await Promise.all([
        Order.aggregate([
          { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
          {
            $facet: {
              summary: [
                {
                  $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    completedOrders: {
                      $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                    },
                    cancelledOrders: {
                      $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
                    },
                    completedOrderValueMinor: {
                      $sum: {
                        $cond: [
                          { $eq: ["$status", "completed"] },
                          { $ifNull: ["$totalMinor", 0] },
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
              daily: [
                {
                  $group: {
                    _id: {
                      $dateToString: {
                        format: "%Y-%m-%d",
                        date: "$createdAt",
                        timezone: timeZone,
                      },
                    },
                    orderCount: { $sum: 1 },
                    completedOrders: {
                      $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                    },
                    cancelledOrders: {
                      $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
                    },
                  },
                },
              ],
            },
          },
        ]).option({ maxTimeMS: 5000 }),
        Payment.aggregate([
          { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
              amountMinor: { $sum: "$amountMinor" },
            },
          },
        ]).option({ maxTimeMS: 5000 }),
        Payment.aggregate([
          { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
          {
            $group: {
              _id: {
                date: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt",
                    timezone: timeZone,
                  },
                },
                status: "$status",
              },
              count: { $sum: 1 },
              amountMinor: { $sum: "$amountMinor" },
            },
          },
        ]).option({ maxTimeMS: 5000 }),
      ]);

      const orderSummary = orderResult[0]?.summary?.[0] ?? {
        totalOrders: 0,
        completedOrders: 0,
        cancelledOrders: 0,
        completedOrderValueMinor: 0,
      };
      const paymentsByStatus = Object.fromEntries(
        ["pending", "paid", "failed", "cancelled", "refunded"].map((status) => [
          status,
          { count: 0, amountMinor: 0 },
        ]),
      );
      for (const row of paymentRows) {
        if (Object.hasOwn(paymentsByStatus, row._id)) {
          paymentsByStatus[row._id] = {
            count: row.count,
            amountMinor: safeAmount(row.amountMinor),
          };
        }
      }

      const daily = Array.from({ length: days }, (_, index) =>
        emptyDay(range.startDate, index),
      );
      const dailyByDate = new Map(daily.map((row) => [row.date, row]));
      for (const row of orderResult[0]?.daily ?? []) {
        const bucket = dailyByDate.get(row._id);
        if (bucket) {
          bucket.orderCount = row.orderCount;
          bucket.completedOrders = row.completedOrders;
          bucket.cancelledOrders = row.cancelledOrders;
        }
      }
      for (const row of paymentDailyRows) {
        const bucket = dailyByDate.get(row._id.date);
        if (!bucket) continue;
        if (row._id.status === "paid") bucket.revenueMinor += safeAmount(row.amountMinor);
      }

      const grossPaidMinor = paymentsByStatus.paid.amountMinor;
      const refundedMinor = paymentsByStatus.refunded.amountMinor;
      const grossCapturedMinor = safeAmount(grossPaidMinor + refundedMinor);
      const netRevenueMinor = grossCapturedMinor - refundedMinor;
      const completedOrders = orderSummary.completedOrders ?? 0;
      const completedOrderValueMinor = safeAmount(orderSummary.completedOrderValueMinor ?? 0);
      return {
        period,
        timeZone,
        range: {
          from: range.startDate,
          to: range.endDate,
          start: range.start.toISOString(),
          endExclusive: range.end.toISOString(),
        },
        summary: {
          totalRevenueMinor: netRevenueMinor,
          totalOrders: orderSummary.totalOrders ?? 0,
          completedOrders,
          cancelledOrders: orderSummary.cancelledOrders ?? 0,
          averageOrderValueMinor: completedOrders
            ? Math.round(completedOrderValueMinor / completedOrders)
            : 0,
          grossPaidMinor: grossCapturedMinor,
          refundedMinor,
        },
        payments: paymentsByStatus,
        trends: daily,
        policies: {
          revenue: "Captured payments (paid or fully refunded) less fully refunded payments; pending, failed, and cancelled payments are excluded.",
          averageOrderValue: "Completed order totals divided by completed order count.",
          orders: "Orders are counted by creation time; cancelled orders remain in order counts.",
        },
      };
    },
  };
}
