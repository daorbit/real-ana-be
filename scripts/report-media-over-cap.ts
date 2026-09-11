import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Subscription } from "../src/modules/billing/models/Subscription.js";
import { Media } from "../src/modules/media/models/Media.js";
import { getPlanCatalogEntry } from "../src/modules/billing/plans.catalog.js";

/**
 * Report-only: which workspaces already hold more media files than their
 * plan's new `maxMediaAssets` cap allows.
 *
 * Nothing is deleted or blocked for files already stored — the cap only
 * stops a workspace from adding more once it's over. This just tells you who
 * is over, in case that is worth a manual nudge or an addon grant.
 *
 *   npx tsx scripts/report-media-over-cap.ts
 */
async function main() {
  await connectDB();

  const subs = await Subscription.find().select("workspaceId planSlug addonMediaSlots");
  console.log(`${subs.length} subscription row(s) to check.\n`);

  let overCount = 0;

  for (const sub of subs) {
    const workspaceId = sub.get("workspaceId");
    if (!workspaceId) continue;

    const planSlug = sub.get("planSlug") as string;
    const plan = getPlanCatalogEntry(planSlug);
    if (!plan) continue;

    const cap = plan.maxMediaAssets + ((sub.get("addonMediaSlots") as number) ?? 0);
    const used = await Media.countDocuments({ workspaceId });

    if (used > cap) {
      overCount++;
      console.log(
        `workspace ${workspaceId}  plan=${planSlug}  used=${used}  cap=${cap}  over by ${used - cap}`,
      );
    }
  }

  console.log(
    overCount
      ? `\n${overCount} workspace(s) over their new media cap. Their existing files are untouched — they just can't upload more until they delete some or an addon/upgrade raises the cap.`
      : "\nNo workspace is over its media cap.",
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
