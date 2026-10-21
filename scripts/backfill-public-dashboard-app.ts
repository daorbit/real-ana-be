import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const used = { shareToken: { $nin: [null, ""] } };
  const pendingFilter = { ...used, "apps.publicDashboard.enabled": { $ne: true } };
  const [total, live, pending] = await Promise.all([
    Workspace.countDocuments(used),
    Workspace.countDocuments({ ...used, shareEnabled: true }),
    Workspace.countDocuments(pendingFilter),
  ]);

  console.log(`${total} workspace(s) have a public dashboard link (${live} live); ${pending} still have the app off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(pendingFilter, {
      $set: { "apps.publicDashboard.enabled": true, "apps.publicDashboard.enabledAt": new Date() },
    });
    console.log(`Turned Quantalog Public Dashboard on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
