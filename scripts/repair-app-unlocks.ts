import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { AppPurchase } from "../src/modules/billing/models/AppPurchase.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";
import { unlockApp } from "../src/modules/billing/paid-apps.js";
import { isPaidApp, PAID_APP_NAMES } from "../src/modules/billing/paid-apps.catalog.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const purchases = await AppPurchase.find({ status: "paid" }).select("workspaceId appId gateway couponCode").lean();
  const workspaceIds = [...new Set(purchases.map((p) => String(p.workspaceId)))];
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("apps");
  const byId = new Map(workspaces.map((w) => [String(w._id), w]));

  const seen = new Set<string>();
  const missing = purchases.filter((p) => {
    const appId = String(p.appId);
    const workspace = byId.get(String(p.workspaceId));
    const key = `${p.workspaceId}:${appId}`;
    if (!isPaidApp(appId) || !workspace || seen.has(key)) return false;
    seen.add(key);
    return !workspace.get(`apps.${appId}.paidAt`);
  });

  console.log(`${purchases.length} paid app purchase(s); ${missing.length} workspace app(s) paid for but still locked.`);
  for (const p of missing) {
    const via = p.gateway === "coupon" ? `coupon ${p.couponCode}` : String(p.gateway);
    console.log(`  ${p.workspaceId}  ${PAID_APP_NAMES[p.appId as keyof typeof PAID_APP_NAMES]}  (${via})`);
  }

  if (WRITE) {
    for (const p of missing) {
      if (isPaidApp(p.appId)) await unlockApp(String(p.workspaceId), p.appId);
    }
    console.log(`Unlocked ${missing.length} workspace app(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
