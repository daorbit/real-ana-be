import type { Types } from "mongoose";
import { AddonPurchase } from "../billing/models/AddonPurchase.js";
import { AppPurchase } from "../billing/models/AppPurchase.js";
import { PlanPurchase } from "../billing/models/PlanPurchase.js";
import { PAID_APP_NAMES, isPaidApp } from "../billing/paid-apps.catalog.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { User } from "../identity/models/User.js";
import { cursorFilter, iso, pageSize } from "./present.js";

export const PAYMENT_STATUSES = ["created", "paid", "failed"] as const;

export type PlatformPayment = {
  id: string;
  kind: "plan" | "addon" | "app";
  description: string;
  gateway: string;
  orderId: string | null;
  gatewayPaymentId: string | null;
  status: "created" | "paid" | "failed";
  amountMinor: number;
  currency: string;
  userId: string;
  userEmail: string;
  subjectId: string | null;
  invoiceNumber: string | null;
  paidAt: string | null;
  createdAt: string;
};

type PurchaseRow = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  workspaceId?: Types.ObjectId | null;
  gateway?: string;
  razorpayOrderId?: string;
  cashfreeOrderId?: string;
  razorpayPaymentId?: string;
  amount: number;
  currency?: string;
  status: "created" | "paid" | "failed";
  invoiceNumber?: string;
  invoicedAt?: Date | null;
  createdAt: Date;
  planSlug?: string;
  cycle?: string;
  addons?: { name: string; packs: number }[];
  appId?: string;
};

const FIELDS = "userId workspaceId gateway razorpayOrderId cashfreeOrderId razorpayPaymentId amount currency status invoiceNumber invoicedAt createdAt";

function describe(kind: PlatformPayment["kind"], row: PurchaseRow): string {
  if (kind === "plan") {
    const name = getPlanCatalogEntry(row.planSlug ?? "")?.name ?? row.planSlug ?? "Plan";
    const extras = row.addons?.length ? ` + ${row.addons.length} add-on${row.addons.length > 1 ? "s" : ""}` : "";
    return `${name} ${row.cycle ?? ""}${extras}`.trim();
  }
  if (kind === "app") return isPaidApp(row.appId) ? PAID_APP_NAMES[row.appId] : row.appId ?? "App";
  return "Add-on pack";
}

function toPayment(kind: PlatformPayment["kind"], row: PurchaseRow, emails: Map<string, string>): PlatformPayment {
  return {
    id: `${kind}:${String(row._id)}`,
    kind,
    description: describe(kind, row),
    gateway: row.gateway ?? "razorpay",
    orderId: row.razorpayOrderId || row.cashfreeOrderId || null,
    gatewayPaymentId: row.razorpayPaymentId || null,
    status: row.status,
    amountMinor: row.amount,
    currency: row.currency ?? "INR",
    userId: String(row.userId),
    userEmail: emails.get(String(row.userId)) ?? "",
    subjectId: row.workspaceId ? String(row.workspaceId) : null,
    invoiceNumber: row.invoiceNumber || null,
    paidAt: row.status === "paid" ? iso(row.invoicedAt ?? null) : null,
    createdAt: iso(row.createdAt) as string,
  };
}

async function withEmails(rows: { kind: PlatformPayment["kind"]; row: PurchaseRow }[]) {
  const ids = [...new Set(rows.map(({ row }) => String(row.userId)))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("email").lean() : [];
  const emails = new Map(users.map((user) => [String(user._id), String(user.email)]));
  return rows.map(({ kind, row }) => toPayment(kind, row, emails));
}

export async function listPlatformPayments(query: { status?: unknown; cursor?: unknown; limit?: unknown; userId?: string }) {
  const limit = pageSize(query.limit);
  const filter: Record<string, unknown> = { ...cursorFilter(query.cursor) };
  if (typeof query.status === "string" && query.status) {
    if (!PAYMENT_STATUSES.includes(query.status as (typeof PAYMENT_STATUSES)[number])) return { items: [], nextCursor: null };
    filter.status = query.status;
  }
  if (query.userId) filter.userId = query.userId;

  const [plans, addons, apps] = await Promise.all([
    PlanPurchase.find(filter).sort({ _id: -1 }).limit(limit + 1).select(`${FIELDS} planSlug cycle addons`).lean<PurchaseRow[]>(),
    AddonPurchase.find(filter).sort({ _id: -1 }).limit(limit + 1).select(FIELDS).lean<PurchaseRow[]>(),
    AppPurchase.find(filter).sort({ _id: -1 }).limit(limit + 1).select(`${FIELDS} appId`).lean<PurchaseRow[]>(),
  ]);

  const merged = [
    ...plans.map((row) => ({ kind: "plan" as const, row })),
    ...addons.map((row) => ({ kind: "addon" as const, row })),
    ...apps.map((row) => ({ kind: "app" as const, row })),
  ].sort((a, b) => (String(b.row._id) > String(a.row._id) ? 1 : -1));

  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await withEmails(page),
    nextCursor: merged.length > limit && last ? String(last.row._id) : null,
  };
}
