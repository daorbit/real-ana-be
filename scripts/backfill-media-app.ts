import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Media } from "../src/modules/media/models/Media.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await Media.distinct("workspaceId");
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.media.enabled": { $ne: true } });

  console.log(`${workspaceIds.length} workspace(s) have media; ${pending} still have Media off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.media.enabled": { $ne: true } },
      { $set: { "apps.media.enabled": true, "apps.media.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Media on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
