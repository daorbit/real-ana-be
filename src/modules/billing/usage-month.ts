import { Subscription } from "./models/Subscription.js";
import { UsageMonth } from "./models/UsageMonth.js";

const COUNTERS = {
  eventsUsed: "events",
  auditsUsed: "audits",
  crawlsUsed: "crawls",
  inspectionsUsed: "inspections",
  formSubmissionsUsed: "formSubmissions",
  orbitUsed: "orbit",
} as const;

type CounterField = keyof typeof COUNTERS;

const ZEROED = Object.fromEntries(Object.keys(COUNTERS).map((field) => [field, 0])) as Record<CounterField, 0>;

const MAX_SETTLED = 10_000;
const settled = new Map<string, string>();

export function usageMonthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function nextUsageReset(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function remember(workspaceId: string, month: string) {
  if (settled.size >= MAX_SETTLED) {
    const oldest = settled.keys().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
  settled.set(workspaceId, month);
}

async function archive(previous: InstanceType<typeof Subscription>): Promise<void> {
  const month = previous.get("usageMonth") as string | null;
  if (!month) return;

  const totals = Object.fromEntries(
    (Object.entries(COUNTERS) as Array<[CounterField, string]>).map(([field, key]) => [
      key,
      (previous.get(field) as number) ?? 0,
    ]),
  );

  await UsageMonth.updateOne(
    { workspaceId: previous.get("workspaceId"), month },
    {
      $set: {
        ...totals,
        planSlug: previous.get("planSlug") ?? "",
        orbitPlanSlug: previous.get("orbitPlanSlug") ?? null,
        closedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function rollUsageMonth(workspaceId: string): Promise<void> {
  const month = usageMonthKey();
  if (settled.get(workspaceId) === month) return;

  await Subscription.updateOne({ workspaceId, usageMonth: null }, { $set: { usageMonth: month } });

  const previous = await Subscription.findOneAndUpdate(
    { workspaceId, usageMonth: { $ne: month } },
    { $set: { usageMonth: month, ...ZEROED } },
    { returnDocument: "before" },
  );
  if (previous) await archive(previous);

  remember(workspaceId, month);
}
