import "dotenv/config";
import { createInterface } from "node:readline";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "../src/infra/db/connection.js";
import { User } from "../src/modules/identity/models/User.js";
import { deleteUserAccount } from "../src/modules/identity/account-deletion.service.js";

const E2E_EMAIL = /^e2e-[a-z0-9-]+@e2e\.quantalog\.test$/;
const E2E_AVATAR = "/favicon.png";

function assertE2eEmail(email: unknown): string {
  const clean = String(email ?? "").trim().toLowerCase();
  if (!E2E_EMAIL.test(clean)) throw new Error(`refusing non-e2e address: ${String(email)}`);
  return clean;
}

async function create(email: string, password: string, firstName: string, lastName = "") {
  const existing = await User.findOne({ email });
  if (existing) await deleteUserAccount(existing.id);

  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
    name: [firstName, lastName].filter(Boolean).join(" "),
    firstName,
    lastName,
    avatarUrl: E2E_AVATAR,
  });
  return { id: user.id, email: user.email };
}

async function remove(email: string) {
  const user = await User.findOne({ email });
  if (user) await deleteUserAccount(user.id);
  return { deleted: user ? 1 : 0 };
}

async function purge() {
  const users = await User.find({ email: /@e2e\.quantalog\.test$/ }).select("_id email");
  const targets = users.filter((u) => E2E_EMAIL.test(u.email));
  await Promise.all(targets.map((user) => deleteUserAccount(user.id)));
  return { deleted: targets.length };
}

function run(command: string, args: unknown[]) {
  if (command === "create") {
    return create(assertE2eEmail(args[0]), String(args[1] ?? ""), String(args[2] ?? "E2E"), String(args[3] ?? ""));
  }
  if (command === "delete") return remove(assertE2eEmail(args[0]));
  if (command === "purge") return purge();
  throw new Error(`unknown command: ${command}`);
}

async function serve() {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const { id, command, args } = JSON.parse(line) as { id: number; command: string; args: unknown[] };
    try {
      process.stdout.write(`${JSON.stringify({ id, ok: true, result: await run(command, args) })}\n`);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);

try {
  await connectDB();
  if (command === "serve") {
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    await serve();
  } else {
    console.log(JSON.stringify(await run(command, args)));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
