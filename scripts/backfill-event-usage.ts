import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Subscription } from "../src/modules/billing/models/Subscription.js";
import { Site } from "../src/modules/analytics/models/Site.js";
import { Event } from "../src/modules/analytics/models/Event.js";
import { getPlanCatalogEntry } from "../src/modules/billing/plans.catalog.js";

/**
 * One-off: fill in `eventsUsed` for workspaces that existed before ingest was
 * metered.
 *
 * Those rows currently read zero while their sites have real traffic behind
 * them, so every existing workspace looks like it has spent none of its new
 * allowance. This counts what each one has actually ingested this billing
 * period and writes it back.
 *
 * Counted from `currentPeriodStart`, not from all time. The quota is per
 * billing cycle and resets when a new period begins, so the honest number is
 * "events since this period started" — which is exactly what the meter would
 * have recorded had it existed. Counting a workspace's entire history would
 * bill it today for traffic from cycles it already paid for, and could put a
 * long-running site over its cap the moment this ran.
 *
 * Safe to re-run: it sets an absolute value rather than incrementing, so a
 * second run recomputes the same figure rather than doubling it.
 *
 *   npx tsx scripts/backfill-event-usage.ts          # report only
 *   npx tsx scripts/backfill-event-usage.ts --write  # apply
 */

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const subs = await Subscription.find().select(
    "workspaceId planSlug currentPeriodStart eventsUsed",
  );
  console.log(`${subs.length} subscription row(s) to inspect.\n`);

  let changed = 0;
  let overQuota = 0;

  for (const sub of subs) {
    const workspaceId = sub.get("workspaceId");
    if (!workspaceId) continue; // pre-workspace rows, if any survive

    const sites = await Site.find({ workspaceId }).select("siteId");
    const siteIds = sites.map((s) => s.get("siteId") as string);

    const planSlug = sub.get("planSlug") as string;
    const plan = getPlanCatalogEntry(planSlug);

    // A row with no period start predates the billing rework. Falling back to
    // the epoch would count all history, which is the outcome this script
    // exists to avoid, so treat it as a fresh period instead.
    const since = (sub.get("currentPeriodStart") as Date | null) ?? new Date();

    const used = siteIds.length
      ? await Event.countDocuments({ siteId: { $in: siteIds }, ts: { $gte: since } })
      : 0;

    const before = (sub.get("eventsUsed") as number) ?? 0;
    if (before === used) continue;

    const quota = plan?.monthlyEventQuota ?? 0;
    const flag = quota > 0 && used >= quota ? "  << over quota" : "";
    if (flag) overQuota++;

    console.log(
      `workspace ${workspaceId}  plan=${planSlug}  sites=${siteIds.length}  ` +
        `since=${since.toISOString().slice(0, 10)}  ${before} -> ${used}/${quota}${flag}`,
    );
    changed++;

    if (WRITE) {
      await Subscription.updateOne({ _id: sub._id }, { $set: { eventsUsed: used } });
    }
  }

  console.log(
    `\n${changed} row(s) ${WRITE ? "updated" : "would change"}.` +
      (overQuota ? ` ${overQuota} already at or over quota.` : ""),
  );
  if (!WRITE && changed) console.log("Re-run with --write to apply.");
  if (overQuota) {
    console.log(
      "\nWorkspaces at or over quota will stop ingesting until their next period.\n" +
        "Check the list above before writing — if any are paying customers, consider\n" +
        "starting a fresh period for them rather than back-billing this one.",
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
