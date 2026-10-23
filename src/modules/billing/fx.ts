import axios from "axios";
import { AppSetting } from "../../config/AppSetting.js";
import { Plan } from "./models/Plan.js";
import { AddonPack } from "./models/AddonPack.js";
import { AppPrice } from "./models/AppPrice.js";
import { DEFAULT_APP_PRICE_INR, PAID_APP_NAMES, PAID_APPS } from "./paid-apps.catalog.js";
import { listResolvedPlans, asPriceMap } from "./plan-pricing.js";
import { CURRENCIES, type Currency } from "./currency.js";


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

export type RepricedApp = {
  appId: string;
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
  apps: RepricedApp[];
};


export async function repriceAllPlans(): Promise<RepriceResult> {
  const snapshot = await fetchRates();
  const derived = CURRENCIES.filter((c) => c !== FX_BASE);

  const priced = (p: { priceMonthly: Record<string, number>; priceYearly: Record<string, number> }) =>
    (p.priceMonthly[FX_BASE] ?? 0) > 0 || (p.priceYearly[FX_BASE] ?? 0) > 0;

  const plans = (await listResolvedPlans()).filter(priced);
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


  const addons = await AddonPack.find();
  const repricedAddons: RepricedAddon[] = [];

  for (const addon of addons) {
    const price = { ...(asPriceMap(addon.get("price")) as Record<string, number>) };
    // Same reason as the plans above: nothing to convert, and reporting it as
    // repriced says a pack changed price when it has none to change.
    if ((price[FX_BASE] ?? 0) <= 0) continue;
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

  const appRows = await AppPrice.find({ appId: { $in: PAID_APPS } }).lean();
  const storedAppPrices = new Map(appRows.map((row) => [row.appId as string, asPriceMap(row.price) ?? {}]));
  const repricedApps: RepricedApp[] = [];

  for (const appId of PAID_APPS) {
    const price: Record<string, number> = { [FX_BASE]: storedAppPrices.get(appId)?.[FX_BASE] || DEFAULT_APP_PRICE_INR };
    for (const currency of derived) {
      price[currency] = convertMinor(price[FX_BASE], currency, snapshot);
    }
    await AppPrice.updateOne({ appId }, { $set: { price } }, { upsert: true });
    repricedApps.push({ appId, name: PAID_APP_NAMES[appId], price });
  }

  return { snapshot, base: FX_BASE, derived, plans: repriced, addons: repricedAddons, apps: repricedApps };
}
