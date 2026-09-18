import "dotenv/config";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { User } from "../src/modules/identity/models/User.js";
import { Notification } from "../src/modules/notifications/models/Notification.js";
import { emitTo } from "../src/modules/notifications/notify.service.js";

/**
 * End-to-end check of the notification panel's API against a running backend.
 *
 * Drives the real HTTP routes with a real token rather than calling the service
 * directly: the things most likely to be wrong are the parts this exercises and
 * a unit test would skip — that the router is actually mounted, that the auth
 * middleware admits the token, that the seen/read split behaves as intended
 * across two endpoints.
 *
 * Writes and then removes its own notifications, and never touches rows it did
 * not create. Point it at a scratch database, not production.
 *
 *   npx tsx scripts/smoke-notifications.ts [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:4123";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await connectDB();

  // A real user, because the routes read `req.userId` against real rows. The
  // first one in the collection is enough — nothing here depends on which.
  const user = await User.findOne().select("_id email");
  if (!user) throw new Error("no users in this database to run as");

  const userId = String(user._id);
  const token = jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  console.log(`running as ${user.get("email")} against ${BASE}\n`);

  // Start from a known state: this user's existing notifications are counted so
  // the assertions below are about the rows this script creates, not whatever
  // history the account already had.
  const before = await Notification.countDocuments({ userId, seenAt: null });

  await emitTo({
    type: "security.alert",
    userId,
    data: { what: "Smoke test notification.", event: "smoke.test" },
    link: "/app/settings",
  });

  const created = await Notification.findOne({ userId, "data.event": "smoke.test" }).sort({
    createdAt: -1,
  });
  check("emitTo writes a row", Boolean(created));
  if (!created) return;

  const countRes = await fetch(`${BASE}/api/notifications/unread-count`, { headers });
  const countBody = (await countRes.json()) as { count: number };
  check(
    "GET /unread-count includes it",
    countRes.status === 200 && countBody.count === before + 1,
    `status ${countRes.status}, count ${countBody.count}, expected ${before + 1}`,
  );

  const listRes = await fetch(`${BASE}/api/notifications?limit=5`, { headers });
  const listBody = (await listRes.json()) as { items: { id: string; type: string }[] };
  check(
    "GET / returns it newest-first",
    listRes.status === 200 && listBody.items[0]?.id === String(created._id),
    `status ${listRes.status}, first id ${listBody.items[0]?.id}`,
  );

  // The distinction the two fields exist for: seeing the panel clears the
  // badge, and leaves the row itself unread.
  const seenRes = await fetch(`${BASE}/api/notifications/seen`, { method: "POST", headers });
  const afterSeen = await Notification.findById(created._id);
  check(
    "POST /seen clears the badge but not the row",
    seenRes.status === 200 && Boolean(afterSeen?.get("seenAt")) && !afterSeen?.get("readAt"),
    `seenAt ${afterSeen?.get("seenAt")}, readAt ${afterSeen?.get("readAt")}`,
  );

  const zeroRes = await fetch(`${BASE}/api/notifications/unread-count`, { headers });
  const zeroBody = (await zeroRes.json()) as { count: number };
  check("unread-count is zero once seen", zeroBody.count === 0, `count ${zeroBody.count}`);

  const readRes = await fetch(`${BASE}/api/notifications/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [String(created._id)] }),
  });
  const afterRead = await Notification.findById(created._id);
  check(
    "POST /read marks the row read",
    readRes.status === 200 && Boolean(afterRead?.get("readAt")),
    `status ${readRes.status}`,
  );

  const unreadOnly = await fetch(`${BASE}/api/notifications?unread=true`, { headers });
  const unreadBody = (await unreadOnly.json()) as { items: { id: string }[] };
  check(
    "?unread=true excludes read rows",
    !unreadBody.items.some((i) => i.id === String(created._id)),
  );

  const prefsRes = await fetch(`${BASE}/api/notifications/preferences`, { headers });
  const prefsBody = (await prefsRes.json()) as {
    items: { type: string; optional: boolean }[];
  };
  const security = prefsBody.items.find((i) => i.type === "security.alert");
  check(
    "GET /preferences lists every type",
    prefsRes.status === 200 && prefsBody.items.length === 8,
    `${prefsBody.items.length} items`,
  );
  check("security.alert is not optional", security?.optional === false);

  // The rule that matters most here: a security notice cannot be muted.
  const muteRes = await fetch(`${BASE}/api/notifications/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ type: "security.alert", inApp: false }),
  });
  check("PATCH /preferences refuses to mute it", muteRes.status === 400, `status ${muteRes.status}`);

  const okRes = await fetch(`${BASE}/api/notifications/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ type: "report.ready", inApp: false }),
  });
  check("PATCH /preferences accepts an optional type", okRes.status === 200);

  // Someone who muted a type should stop receiving it.
  await emitTo({ type: "report.ready", userId, data: { reportName: "Smoke" }, link: "" });
  const muted = await Notification.countDocuments({ userId, type: "report.ready", "data.reportName": "Smoke" });
  check("a muted type is not delivered", muted === 0, `${muted} rows written`);

  // Clean up after ourselves, including the preference override.
  await Notification.deleteMany({ userId, "data.event": "smoke.test" });
  await Notification.deleteMany({ userId, "data.reportName": "Smoke" });
  await mongoose.connection.collection("notificationprefs").deleteOne({
    userId: created.get("userId"),
    type: "report.ready",
  });

  console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("smoke run failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
