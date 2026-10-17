import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { GoalTarget } from "../src/modules/dashboards/models/GoalTarget.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await GoalTarget.distinct("workspaceId");
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.goals.enabled": { $ne: true } });

  console.log(`${workspaceIds.length} workspace(s) have goals; ${pending} still have Goals off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.goals.enabled": { $ne: true } },
      { $set: { "apps.goals.enabled": true, "apps.goals.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Goals on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
