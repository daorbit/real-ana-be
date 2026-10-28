import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { User } from "../src/modules/identity/models/User.js";
import { Membership, WORKSPACE_ROLES, type WorkspaceRole } from "../src/modules/workspace/models/Membership.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

async function main() {
  const email = arg("email").toLowerCase();
  const workspaceName = arg("name");
  const role = arg("role") as WorkspaceRole;

  if (!email || !workspaceName || !WORKSPACE_ROLES.includes(role) || role === "owner") {
    console.log('Usage: npm run set:member-role -- --email=<email> --name="<workspace name>" --role=admin|editor|viewer [--write]');
    process.exit(1);
  }

  await connectDB();

  const user = await User.findOne({ email }).select("_id name email").lean();
  if (!user) throw new Error(`No user with email ${email}`);

  const memberships = await Membership.find({ userId: user._id }).select("workspaceId role").lean();
  const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) } })
    .select("_id name")
    .lean();
  const nameById = new Map(workspaces.map((w) => [String(w._id), w.name]));

  console.log(`${user.name} <${user.email}> has ${memberships.length} workspace(s):`);
  for (const m of memberships) console.log(`  ${nameById.get(String(m.workspaceId)) ?? "(missing)"}  ${m.role}`);

  const matches = memberships.filter(
    (m) => (nameById.get(String(m.workspaceId)) ?? "").toLowerCase() === workspaceName.toLowerCase(),
  );
  if (matches.length !== 1) throw new Error(`Expected one workspace named "${workspaceName}", found ${matches.length}`);

  const target = matches[0];
  if (target.role === "owner") throw new Error("This user owns the workspace; owners are not changed by this script.");
  if (target.role === role) {
    console.log(`\nAlready ${role}. Nothing to do.`);
  } else if (WRITE) {
    await Membership.updateOne({ _id: target._id, role: target.role }, { $set: { role } });
    console.log(`\nChanged role in "${workspaceName}" from ${target.role} to ${role}.`);
  } else {
    console.log(`\nWould change role in "${workspaceName}" from ${target.role} to ${role}.`);
    console.log("Dry run. Re-run with --write to apply.");
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await mongoose.disconnect();
  process.exit(1);
});
