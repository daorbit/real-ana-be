import { razorpay } from "../../infra/payments/razorpay.js";
import { Plan } from "./models/Plan.js";
import { PlanPurchase } from "./models/PlanPurchase.js";
import {
  BILLING_CYCLES,
  RENEWAL_STATUSES,
  Subscription,
  type BillingCycle,
  type RenewalStatus,
} from "./models/Subscription.js";
import { previewPeriodEnd } from "./quota.service.js";
import type { Currency } from "./currency.js";

const TOTAL_CHARGES: Record<BillingCycle, number> = { monthly: 60, yearly: 5 };
const CYCLE_MS: Record<BillingCycle, number> = { monthly: 30 * 86_400_000, yearly: 365 * 86_400_000 };
const RENEWAL_GRACE_MS = 3 * 86_400_000;
const MIN_START_LEAD_MS = 60 * 60 * 1000;
const MIN_CHARGE = 100;
const LIVE_STATUSES: RenewalStatus[] = ["authenticated", "active", "pending"];

export type RazorpaySubscriptionEntity = {
  id: string;
  status?: string;
  charge_at?: number | null;
  notes?: unknown;
};

export type SubscriptionMeta = {
  workspaceId: string;
  userId: string;
  planSlug: string;
  cycle: BillingCycle;
};

export function subscriptionMeta(entity: RazorpaySubscriptionEntity): SubscriptionMeta | null {
  const notes = (entity.notes ?? {}) as Record<string, unknown>;
  const cycle = String(notes.cycle ?? "") as BillingCycle;
  const meta = {
    workspaceId: String(notes.workspaceId ?? ""),
    userId: String(notes.userId ?? ""),
    planSlug: String(notes.planSlug ?? ""),
    cycle,
  };
  if (!meta.workspaceId || !meta.userId || !meta.planSlug || !BILLING_CYCLES.includes(cycle)) return null;
  return meta;
}

export function nextChargeDate(entity: RazorpaySubscriptionEntity): Date | null {
  return entity.charge_at ? new Date(entity.charge_at * 1000) : null;
}

export function renewalPeriodEnd(entity: RazorpaySubscriptionEntity, cycle: BillingCycle): Date {
  const next = nextChargeDate(entity);
  return new Date((next ? next.getTime() : Date.now() + CYCLE_MS[cycle]) + RENEWAL_GRACE_MS);
}

function toRenewalStatus(value: unknown, fallback: RenewalStatus): RenewalStatus {
  return RENEWAL_STATUSES.includes(value as RenewalStatus) ? (value as RenewalStatus) : fallback;
}

async function razorpayPlanId(
  planSlug: string,
  planName: string,
  cycle: BillingCycle,
  currency: Currency,
  amount: number,
): Promise<string> {
  const key = `${cycle}_${currency}_${amount}`;
  const row = await Plan.findOne({ slug: planSlug }).select("razorpayPlanIds").lean();
  const known = (row?.razorpayPlanIds as unknown as Record<string, string> | undefined)?.[key];
  if (known) return known;

  const created = await razorpay().plans.create({
    period: cycle,
    interval: 1,
    item: { name: `Quantalog ${planName} (${cycle})`, amount, currency },
  });
  await Plan.updateOne({ slug: planSlug }, { $set: { [`razorpayPlanIds.${key}`]: created.id } }, { upsert: true });
  return created.id;
}

export async function autoRenewState(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId }).select(
    "planSlug cycle currentPeriodEnd autoRenew renewalStatus razorpaySubscriptionId",
  );
  const live = Boolean(sub?.get("autoRenew")) && LIVE_STATUSES.includes(sub?.get("renewalStatus") as RenewalStatus);
  return { sub, live };
}

export async function openAutoRenewCheckout(params: {
  workspaceId: string;
  userId: string;
  planSlug: string;
  planName: string;
  cycle: BillingCycle;
  currency: Currency;
  amount: number;
  coupon: { code: string; amount: number } | null;
}): Promise<
  | { ok: true; subscriptionId: string; upfront: number; deferred: boolean; startsAt: Date }
  | { ok: false; error: string; code: string }
> {
  const { workspaceId, userId, planSlug, planName, cycle, currency, amount, coupon } = params;
  const { sub } = await autoRenewState(workspaceId);
  const periodEnd = sub?.get("currentPeriodEnd") as Date | null;
  const keepsCurrentPeriod =
    sub?.get("planSlug") === planSlug &&
    sub?.get("cycle") === cycle &&
    !!periodEnd &&
    periodEnd.getTime() - Date.now() > MIN_START_LEAD_MS;

  if (keepsCurrentPeriod && coupon) {
    return {
      ok: false,
      error: "nothing is charged today when auto-renew starts at the end of your current period, so a coupon can't apply",
      code: "coupon_nothing_due",
    };
  }

  const startsAt = keepsCurrentPeriod ? periodEnd! : (await previewPeriodEnd(workspaceId, planSlug, cycle)).periodEnd;
  const firstCharge = coupon ? coupon.amount : amount;
  const upfront = keepsCurrentPeriod ? 0 : Math.max(firstCharge, MIN_CHARGE);

  const planId = await razorpayPlanId(planSlug, planName, cycle, currency, amount);
  const created = await razorpay().subscriptions.create({
    plan_id: planId,
    total_count: TOTAL_CHARGES[cycle],
    customer_notify: 1,
    start_at: Math.floor(startsAt.getTime() / 1000),
    ...(upfront > 0
      ? { addons: [{ item: { name: `Quantalog ${planName} — first ${cycle === "yearly" ? "year" : "month"}`, amount: upfront, currency } }] }
      : {}),
    notes: { workspaceId, userId, planSlug, cycle },
  });

  if (!keepsCurrentPeriod) {
    await PlanPurchase.create({
      userId,
      workspaceId,
      planSlug,
      cycle,
      addons: [],
      planAmount: amount,
      gateway: "razorpay",
      razorpaySubscriptionId: created.id,
      startsAt,
      amount: upfront,
      currency,
      couponCode: coupon?.code ?? "",
      status: "created",
    });
  }

  return { ok: true, subscriptionId: created.id, upfront, deferred: keepsCurrentPeriod, startsAt };
}

export async function adoptSubscription(
  workspaceId: string,
  entity: RazorpaySubscriptionEntity,
  fallback: RenewalStatus,
) {
  const sub = await Subscription.findOne({ workspaceId }).select("razorpaySubscriptionId renewalStatus");
  if (!sub) return;
  const previous = sub.get("razorpaySubscriptionId") as string | null;
  const status = toRenewalStatus(entity.status, fallback);
  const keepActive = previous === entity.id && sub.get("renewalStatus") === "active" && status === "authenticated";

  await Subscription.updateOne(
    { workspaceId },
    {
      $set: {
        razorpaySubscriptionId: entity.id,
        autoRenew: true,
        renewalStatus: keepActive ? "active" : status,
        nextChargeAt: nextChargeDate(entity),
      },
    },
  );

  if (previous && previous !== entity.id) {
    await razorpay()
      .subscriptions.cancel(previous, false)
      .catch((e: unknown) => console.error("[auto-renew] could not cancel replaced subscription", previous, (e as Error).message));
  }
}

export async function updateRenewalStatus(entity: RazorpaySubscriptionEntity, status: RenewalStatus) {
  await Subscription.updateOne(
    { razorpaySubscriptionId: entity.id },
    {
      $set: {
        renewalStatus: status,
        autoRenew: LIVE_STATUSES.includes(status),
        nextChargeAt: LIVE_STATUSES.includes(status) ? nextChargeDate(entity) : null,
      },
    },
  );
}

export async function cancelAutoRenew(workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sub, live } = await autoRenewState(workspaceId);
  const subscriptionId = sub?.get("razorpaySubscriptionId") as string | null;
  if (!sub || !live || !subscriptionId) return { ok: false, error: "auto-renew is not on for this workspace" };

  const atCycleEnd = sub.get("renewalStatus") === "active";
  try {
    await razorpay().subscriptions.cancel(subscriptionId, atCycleEnd);
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Razorpay could not cancel the subscription" };
  }

  await Subscription.updateOne(
    { workspaceId },
    { $set: { autoRenew: false, renewalStatus: "cancelled", nextChargeAt: null } },
  );
  return { ok: true };
}

export async function cancelWorkspaceRenewals(workspaceIds: string[]) {
  const subs = await Subscription.find({
    workspaceId: { $in: workspaceIds },
    razorpaySubscriptionId: { $ne: null },
    renewalStatus: { $in: LIVE_STATUSES },
  })
    .select("razorpaySubscriptionId")
    .lean();

  await Promise.all(
    subs.map((sub) =>
      razorpay()
        .subscriptions.cancel(String(sub.razorpaySubscriptionId), false)
        .catch((e: unknown) =>
          console.error("[auto-renew] could not cancel on workspace delete", sub.razorpaySubscriptionId, (e as Error).message),
        ),
    ),
  );
}

export async function paidUpfrontPayment(
  subscriptionId: string,
): Promise<{ id: string; amount: number; currency: string } | null> {
  const pending = await PlanPurchase.exists({
    razorpaySubscriptionId: subscriptionId,
    status: "created",
    chargeId: { $exists: false },
  });
  if (!pending) return null;
  const invoices = await razorpay().invoices.all({ subscription_id: subscriptionId });
  const paid = invoices.items.find((invoice) => invoice.status === "paid" && invoice.payment_id);
  if (!paid?.payment_id) return null;
  const amounts = paid as { amount_paid?: number | null; amount?: number | string | null };
  return {
    id: paid.payment_id,
    amount: Number(amounts.amount_paid ?? amounts.amount ?? 0),
    currency: String(paid.currency ?? "INR"),
  };
}
