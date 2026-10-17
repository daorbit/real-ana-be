import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { GoogleConnection } from "../src/modules/reviews/models/GoogleConnection.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await GoogleConnection.distinct("workspaceId");
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.reviews.enabled": { $ne: true } });

  console.log(`${workspaceIds.length} workspace(s) have Google connected; ${pending} still have Reviews off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.reviews.enabled": { $ne: true } },
      { $set: { "apps.reviews.enabled": true, "apps.reviews.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Reviews on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
