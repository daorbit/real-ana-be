import { Workspace } from "../workspace/models/Workspace.js";
import { onAppToggled } from "../workspace/app-hooks.js";
import { AppPrice } from "./models/AppPrice.js";
import { asPriceMap } from "./plan-pricing.js";
import { convertMinor, FX_BASE, getCachedRates } from "./fx.js";
import { CURRENCIES, type Currency } from "./currency.js";
import { DEFAULT_APP_PRICE_INR, PAID_APP_NAMES, PAID_APPS, paidAppUnlocked, type PaidApp } from "./paid-apps.catalog.js";

export type ResolvedAppPrice = {
  appId: PaidApp;
  name: string;
  price: Record<Currency, number>;
};

type AppsCarrier = { get: (path: string) => unknown };

export async function listAppPrices(): Promise<ResolvedAppPrice[]> {
  const [rows, snapshot] = await Promise.all([AppPrice.find({ appId: { $in: PAID_APPS } }).lean(), getCachedRates()]);
  const byApp = new Map(rows.map((row) => [row.appId as string, asPriceMap(row.price) ?? {}]));

  return PAID_APPS.map((appId) => {
    const stored = byApp.get(appId) ?? {};
    const base = stored[FX_BASE] || DEFAULT_APP_PRICE_INR;
    const price = Object.fromEntries(
      CURRENCIES.map((currency) => {
        if (currency === FX_BASE) return [currency, base];
        if (stored[currency]) return [currency, stored[currency] as number];
        return [currency, snapshot ? convertMinor(base, currency, snapshot) : 0];
      }),
    ) as Record<Currency, number>;
    return { appId, name: PAID_APP_NAMES[appId], price };
  });
}

export async function appPrice(appId: PaidApp, currency: Currency): Promise<number> {
  const prices = await listAppPrices();
  return prices.find((p) => p.appId === appId)?.price[currency] ?? 0;
}

export function appUnlocked(workspace: AppsCarrier, app: string): boolean {
  return paidAppUnlocked(workspace, app);
}

export async function unlockApp(workspaceId: string, app: PaidApp): Promise<void> {
  const now = new Date();
  await Workspace.updateOne(
    { _id: workspaceId },
    { $set: { [`apps.${app}.paidAt`]: now, [`apps.${app}.enabled`]: true, [`apps.${app}.enabledAt`]: now } },
  );
  await onAppToggled(workspaceId, app, true);
}
