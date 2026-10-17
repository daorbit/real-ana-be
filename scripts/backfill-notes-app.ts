import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Note } from "../src/modules/notes/models/Note.js";
import { Membership } from "../src/modules/workspace/models/Membership.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const userIds = await Note.distinct("userId");
  const workspaceIds = await Membership.distinct("workspaceId", { userId: { $in: userIds } });
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.notes.enabled": { $ne: true } });

  console.log(
    `${userIds.length} user(s) have notes across ${workspaceIds.length} workspace(s); ${pending} still have Notes off.`,
  );

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.notes.enabled": { $ne: true } },
      { $set: { "apps.notes.enabled": true, "apps.notes.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Notes on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
