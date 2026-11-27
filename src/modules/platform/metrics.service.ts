import mongoose from "mongoose";
import { Site } from "../analytics/models/Site.js";
import { AddonPurchase } from "../billing/models/AddonPurchase.js";
import { AppPurchase } from "../billing/models/AppPurchase.js";
import { PlanPurchase } from "../billing/models/PlanPurchase.js";
import { Subscription } from "../billing/models/Subscription.js";
import { Session } from "../identity/models/Session.js";
import { User } from "../identity/models/User.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { idRange } from "./present.js";

const CACHE_MS = 5 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;

export type MetricsSummary = {
  from: string;
  to: string;
  users: { total: number; new: number; active: number | null };
  paying: number;
  revenue: { currency: string; amountMinor: number }[];
  extra: { key: string; label: string; value: number }[];
};

const cache = createTtlCache<MetricsSummary>(CACHE_MS, 50);

export function readRange(fromValue: unknown, toValue: unknown) {
  const now = Date.now();
  const to = new Date(typeof toValue === "string" && !Number.isNaN(Date.parse(toValue)) ? Math.min(Date.parse(toValue), now) : now);
  const fallback = to.getTime() - 30 * DAY_MS;
  const parsedFrom = typeof fromValue === "string" && !Number.isNaN(Date.parse(fromValue)) ? Date.parse(fromValue) : fallback;
  const from = new Date(Math.max(Math.min(parsedFrom, to.getTime()), to.getTime() - MAX_RANGE_DAYS * DAY_MS));
  return { from, to };
}

type Totals = { _id: string; amount: number };

async function revenue(from: Date, to: Date) {
  const match = { $match: { _id: idRange(from, to), status: "paid", gateway: { $ne: "coupon" } } };
  const group = { $group: { _id: { $ifNull: ["$currency", "INR"] }, amount: { $sum: "$amount" } } };
  const results = await Promise.all([
    PlanPurchase.aggregate<Totals>([match, group]),
    AddonPurchase.aggregate<Totals>([match, group]),
    AppPurchase.aggregate<Totals>([match, group]),
  ]);
  const sums = new Map<string, number>();
  for (const row of results.flat()) sums.set(row._id, (sums.get(row._id) ?? 0) + row.amount);
  return [...sums].map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

async function compute(from: Date, to: Date): Promise<MetricsSummary> {
  const now = new Date();
  const [total, created, active, paying, money, workspaces, sites, invoicing] = await Promise.all([
    User.estimatedDocumentCount(),
    User.countDocuments({ _id: idRange(from, to) }),
    Session.distinct("userId", { lastSeenAt: { $gte: from, $lt: to } }),
    Subscription.countDocuments({ planSlug: { $ne: "free" }, status: { $ne: "expired" }, currentPeriodEnd: { $gte: now } }),
    revenue(from, to),
    Workspace.estimatedDocumentCount(),
    Site.estimatedDocumentCount(),
    Workspace.countDocuments({ "apps.invoicing.enabled": true }),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    users: { total, new: created, active: active.length },
    paying,
    revenue: money,
    extra: [
      { key: "workspaces", label: "Workspaces", value: workspaces },
      { key: "sites", label: "Sites", value: sites },
      { key: "invoicing", label: "Workspaces with Invoicing on", value: invoicing },
    ],
  };
}

export function metricsSummary(from: Date, to: Date) {
  const minute = (date: Date) => Math.floor(date.getTime() / 60_000);
  return cache(`${minute(from)}:${minute(to)}`, () => compute(from, to));
}

export async function databaseHealth() {
  const started = Date.now();
  try {
    await mongoose.connection.db?.admin().ping();
    return { name: "database", ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { name: "database", ok: false, latencyMs: Date.now() - started, detail: (error as Error).message };
  }
}
