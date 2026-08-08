import "dotenv/config";
import { connectDB } from "../src/infra/db/connection.js";
import { Plan } from "../src/modules/billing/models/Plan.js";
import { Subscription } from "../src/modules/billing/models/Subscription.js";
import { User } from "../src/modules/identity/models/User.js";
import { PLAN_CATALOG } from "../src/modules/billing/plans.catalog.js";
import mongoose from "mongoose";

/**
 * One-off: make sure every plan in the fixed catalogue (`src/plans.ts`) has a
 * price row, and move every user with no subscription onto Free. Safe to
 * re-run — price rows are only created if missing (never overwritten, so it
 * won't clobber a price an admin has already set), and only users with zero
 * `Subscription` rows are touched.
 *
 *   npx tsx scripts/seed-billing.ts
 */
async function main() {
  await connectDB();

  console.log("Ensuring a price row exists for every catalogue plan...");
  const defaultPrices: Record<string, { priceMonthly: number; priceYearly: number }> = {
    free: { priceMonthly: 0, priceYearly: 0 },
    starter: { priceMonthly: 99900, priceYearly: 999900 }, // ₹999/mo, ₹9,999/yr
    pro: { priceMonthly: 299900, priceYearly: 2999900 }, // ₹2,999/mo, ₹29,999/yr
  };

  for (const plan of PLAN_CATALOG) {
    const existing = await Plan.findOne({ slug: plan.slug });
    if (existing) {
      console.log(`  ${plan.slug}: already has a price row, leaving it alone`);
      continue;
    }
    const price = defaultPrices[plan.slug] ?? { priceMonthly: 0, priceYearly: 0 };
    await Plan.create({ slug: plan.slug, ...price });
    console.log(`  ${plan.slug}: seeded at ₹${price.priceMonthly / 100}/mo, ₹${price.priceYearly / 100}/yr`);
  }

  const free = PLAN_CATALOG.find((p) => p.slug === "free")!;
  const usersWithSub = await Subscription.distinct("userId");
  const usersWithoutSub = await User.find({ _id: { $nin: usersWithSub } }).select("_id");

  if (usersWithoutSub.length) {
    console.log(`\nMoving ${usersWithoutSub.length} user(s) onto Free...`);
    await Subscription.insertMany(
      usersWithoutSub.map((u) => ({
        userId: u._id,
        planSlug: free.slug,
        cycle: "monthly" as const,
        status: "active" as const,
        currentPeriodStart: new Date(),
        // Free is never bought and never auto-renews — a year out is just far
        // enough that expiry never becomes something a Free user has to think
        // about. Re-run this script periodically (or bump the window) if that
        // ever needs to be longer.
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      }))
    );
  } else {
    console.log("\nEvery user already has a subscription row — nothing to migrate.");
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
