import axios from "axios";
import { AppSetting } from "../models/AppSetting.js";
import type { Currency } from "./currency.js";

/**
 * USD pricing, derived from the INR price an admin actually types.
 *
 * Prices are authored once, in INR. Keeping a second hand-maintained USD
 * number alongside it means the two drift apart the moment the rupee moves,
 * and nobody notices until a US customer is quoted last quarter's price. So
 * the USD column is computed from a live rate instead.
 *
 * The refresh is a button an admin presses, not a cron: exchange rates move
 * slowly enough that a daily job buys nothing, and a price that changes on its
 * own — mid-checkout, without anyone deciding to — is worse than a stale one.
 * The admin sees the rate, presses the button, prices change. That's the whole
 * contract.
 *
 * The last fetched rate is cached in `AppSetting` so the admin screen can show
 * what the current prices were computed from without spending an API call on
 * every page load.
 */

/** Base currency every stored price is authored in. */
export const FX_BASE: Currency = "INR";

const SETTING_FX_RATES = "fx.rates";

/** exchangerate-api.com free tier updates once every 24h, so anything fresher is wasted. */
const API_BASE = "https://v6.exchangerate-api.com/v6";

export type FxSnapshot = {
  /** Units of the quote currency per 1 INR — e.g. `{ USD: 0.0115 }`. */
  rates: Partial<Record<Currency, number>>;
  /** When we fetched it (ISO). */
  fetchedAt: string;
  /** When the provider says the next update lands (ISO), if it told us. */
  nextUpdateAt?: string;
};

export function fxConfigured(): boolean {
  return Boolean(process.env.EXCHANGERATE_API_KEY);
}

/**
 * Live rates for `FX_BASE`, straight from the provider.
 *
 * Throws rather than falling back to a cached value: the caller is about to
 * rewrite every plan's price, and doing that from a rate of unknown age is
 * exactly the silent staleness this whole module exists to prevent.
 */
export async function fetchRates(): Promise<FxSnapshot> {
  const key = process.env.EXCHANGERATE_API_KEY;
  if (!key) throw new Error("EXCHANGERATE_API_KEY is not set");

  const { data } = await axios.get(`${API_BASE}/${key}/latest/${FX_BASE}`, { timeout: 15_000 });

  if (data?.result !== "success") {
    // The provider answers 200 with `{ result: "error", "error-type": ... }`
    // for a bad key or an unsupported base, so status alone proves nothing.
    throw new Error(`exchangerate-api: ${data?.["error-type"] ?? "unexpected response"}`);
  }

  const usd = Number(data?.conversion_rates?.USD);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("exchangerate-api: no usable USD rate in response");
  }

  const snapshot: FxSnapshot = {
    rates: { USD: usd },
    fetchedAt: new Date().toISOString(),
    nextUpdateAt: data?.time_next_update_unix
      ? new Date(Number(data.time_next_update_unix) * 1000).toISOString()
      : undefined,
  };

  await AppSetting.updateOne(
    { key: SETTING_FX_RATES },
    { $set: { value: snapshot } },
    { upsert: true }
  );

  return snapshot;
}

/** The last successfully fetched rates, or null if the button has never been pressed. */
export async function getCachedRates(): Promise<FxSnapshot | null> {
  const row = await AppSetting.findOne({ key: SETTING_FX_RATES });
  const value = row?.get("value") as FxSnapshot | undefined;
  return value && Number.isFinite(value.rates?.USD) ? value : null;
}

/**
 * Convert a minor-unit amount from `FX_BASE` into `currency`.
 *
 * Both currencies here have two decimal places, so the minor-unit factor
 * cancels out and the rate applies directly to the stored integer. Rounding is
 * to the nearest cent — Razorpay only accepts integers.
 */
export function convertMinor(amountMinor: number, currency: Currency, snapshot: FxSnapshot): number {
  if (currency === FX_BASE) return amountMinor;
  const rate = snapshot.rates[currency];
  if (!Number.isFinite(rate) || (rate as number) <= 0) {
    throw new Error(`no rate available for ${currency}`);
  }
  return Math.max(0, Math.round(amountMinor * (rate as number)));
}
