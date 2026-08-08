/**
 * Currencies sold through Razorpay's international checkout. All three use
 * two decimal places, so the smallest-unit conversion (`* 100`) is the same
 * for all of them — unlike currencies such as JPY, which have none.
 */
export const CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "INR";

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Falls back to INR for anything unrecognised — never trust the client blindly. */
export function resolveCurrency(value: unknown): Currency {
  return isCurrency(value) ? value : DEFAULT_CURRENCY;
}
