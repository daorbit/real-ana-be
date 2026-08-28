import axios from "axios";
import { AppSetting } from "../../config/AppSetting.js";
import { Plan } from "./models/Plan.js";
import { AddonPack } from "./models/AddonPack.js";
import { listResolvedPlans, listResolvedOrbitPlans } from "./plan-pricing.js";
import { CURRENCIES, type Currency } from "./currency.js";

/**
 * USD pricing, derived from the INR price an admin actually types.
 *
 * Prices are authored once, in INR. Keeping a second hand-maintained USD
 * number alongside it means the two drift apart the moment the rupee moves,
 * and nobody notices until a US customer is quoted last quarter's price. So
 * the USD column is computed from a live rate instead.
 *
 * Two things trigger a reprice, and both call `repriceAllPlans` below:
 *
 *  - a nightly `node-cron` job (`lib/fx-cron.ts`), so prices track the rate
 *    without anyone remembering to look;
 *  - an admin button, for when the rate has moved and waiting for tonight
 *    isn't acceptable.
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

export type RepricedPlan = {
  slug: string;
  name: string;
  priceMonthly: Record<string, number>;
  priceYearly: Record<string, number>;
};

export type RepricedAddon = {
  slug: string;
  name: string;
  price: Record<string, number>;
};

export type RepriceResult = {
  snapshot: FxSnapshot;
  base: Currency;
  /** The currencies that were recomputed — everything except the base. */
  derived: Currency[];
  plans: RepricedPlan[];
  addons: RepricedAddon[];
};

/**
 * Recompute every plan's non-base price from its base price at the current rate.
 *
 * Shared by the admin button and the nightly job so the two can't drift into
 * doing subtly different things to the same prices.
 *
 * Fetches the rate fresh rather than reading the cache: the point of a reprice
 * is that the new numbers reflect today's rate, not whenever someone last
 * looked. If the fetch fails this throws and nothing is touched — a partial
 * reprice, where some prices moved and others didn't, is worse than none.
 */
export async function repriceAllPlans(): Promise<RepriceResult> {
  const snapshot = await fetchRates();
  const derived = CURRENCIES.filter((c) => c !== FX_BASE);
  // Both ladders, because both are priced in INR and both are sold in every
  // currency — an Orbit tier left out here would quietly keep quoting whatever
  // the rate was on the day someone typed its price in.
  const plans = [...(await listResolvedPlans()), ...(await listResolvedOrbitPlans())];
  const repriced: RepricedPlan[] = [];

  for (const plan of plans) {
    const priceMonthly = { ...plan.priceMonthly };
    const priceYearly = { ...plan.priceYearly };
    for (const currency of derived) {
      priceMonthly[currency] = convertMinor(plan.priceMonthly[FX_BASE] ?? 0, currency, snapshot);
      priceYearly[currency] = convertMinor(plan.priceYearly[FX_BASE] ?? 0, currency, snapshot);
    }

    await Plan.updateOne({ slug: plan.slug }, { $set: { priceMonthly, priceYearly } }, { upsert: true });
    repriced.push({ slug: plan.slug, name: plan.name, priceMonthly, priceYearly });
  }

  // Add-on packs are priced in INR the same way and sold in every currency, so
  // they track the rate on the same run — otherwise their USD price stays
  // frozen at whatever it was when the pack was created, while plans move.
  const addons = await AddonPack.find();
  const repricedAddons: RepricedAddon[] = [];

  for (const addon of addons) {
    const price = { ...(addon.get("price") as Record<string, number>) };
    for (const currency of derived) {
      price[currency] = convertMinor(price[FX_BASE] ?? 0, currency, snapshot);
    }
    await AddonPack.updateOne({ _id: addon._id }, { $set: { price } });
    repricedAddons.push({
      slug: addon.get("slug") as string,
      name: addon.get("name") as string,
      price,
    });
  }

  return { snapshot, base: FX_BASE, derived, plans: repriced, addons: repricedAddons };
}
