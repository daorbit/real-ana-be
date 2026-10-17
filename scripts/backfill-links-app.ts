import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

const HAS_LINKS = { "navPrefs.links.0": { $exists: true }, "apps.links.enabled": { $ne: true } };

async function main() {
  await connectDB();

  const pending = await Workspace.countDocuments(HAS_LINKS);
  console.log(`${pending} workspace(s) have sidebar links but Links off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(HAS_LINKS, {
      $set: { "apps.links.enabled": true, "apps.links.enabledAt": new Date() },
    });
    console.log(`Turned Quantalog Links on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
