export function calculateOrderPricing(
  lines,
  taxRateBasisPoints,
  roundingPolicy = "half_up",
) {
  if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0 || taxRateBasisPoints > 10000) {
    throw new Error("Tax rate must be configured as integer basis points from 0 to 10000");
  }
  if (roundingPolicy !== "half_up") {
    throw new Error("Unsupported tax rounding policy");
  }

  const subtotalMinor = lines.reduce(
    (subtotal, line) => subtotal + line.unitPriceMinor * line.quantity,
    0,
  );
  if (!Number.isSafeInteger(subtotalMinor)) {
    throw new Error("Order subtotal exceeds the supported integer range");
  }

  const taxMinor = Number(
    (BigInt(subtotalMinor) * BigInt(taxRateBasisPoints) + 5000n) / 10000n,
  );
  if (!Number.isSafeInteger(taxMinor)) {
    throw new Error("Order tax exceeds the supported integer range");
  }

  const discountMinor = 0;
  const totalMinor = subtotalMinor + taxMinor - discountMinor;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new Error("Order total exceeds the supported integer range");
  }
  return {
    subtotalMinor,
    taxRateBasisPoints,
    taxRoundingPolicy: roundingPolicy,
    taxMinor,
    discountMinor,
    totalMinor,
  };
}
