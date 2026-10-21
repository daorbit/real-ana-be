import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { SeoReport } from "../src/modules/seo/models/SeoReport.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await SeoReport.distinct("workspaceId", { shareToken: { $nin: [null, ""] } });
  const pendingFilter = { _id: { $in: workspaceIds }, "apps.seoReports.enabled": { $ne: true } };
  const pending = await Workspace.countDocuments(pendingFilter);

  console.log(`${workspaceIds.length} workspace(s) have shared an SEO report; ${pending} still have the app off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(pendingFilter, {
      $set: { "apps.seoReports.enabled": true, "apps.seoReports.enabledAt": new Date() },
    });
    console.log(`Turned Quantalog SEO Reports on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
