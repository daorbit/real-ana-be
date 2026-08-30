/**
 * Exercises the collect route's two wire shapes without touching the database.
 *
 * Tracker v8 batches events; every earlier version posts one flat event. Both
 * have to keep working, and the difference is easy to break silently — a batch
 * that quietly records one event, or a legacy beacon that stops recording at
 * all, looks identical to "traffic went down" on the dashboard.
 *
 * Run against the built output:
 *   npm run build
 *   node --import ./scripts/collect-batch-stubs-register.mjs scripts/check-collect-batch.mjs
 *
 * The database-backed modules are replaced by the loader hook in
 * collect-batch-stubs.mjs, so nothing here writes to Mongo.
 */

import express from "express";

const { Event } = await import("../dist/modules/analytics/models/Event.js");
const { meter } = await import("../dist/modules/billing/event-quota.js");
const inserted = Event.docs;

const collect = (await import("../dist/http/routes/collect.js")).default;

const app = express();
app.use(express.text({ type: "*/*" }));
app.use("/api/collect", collect);

const server = app.listen(0);
const port = server.address().port;
const url = `http://127.0.0.1:${port}/api/collect`;

const send = async (body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });
  return res.status;
};

const reset = () => { inserted.length = 0; meter.counted = 0; };
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return console.log(`ok   ${name}`);
  failures++;
  console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
};

// --- legacy: one flat event, the shape every tracker before v8 sends ---
reset();
let status = await send({ siteId: "s1", type: "pageview", path: "/pricing", v: 7 });
check("legacy single event accepted", status === 204, `status ${status}`);
check("legacy writes one document", inserted.length === 1, `wrote ${inserted.length}`);
check("legacy keeps its path", inserted[0]?.path === "/pricing", inserted[0]?.path);
check("legacy billed once", meter.counted === 1, `counted ${meter.counted}`);

// --- v8: a batch envelope ---
reset();
status = await send({
  siteId: "s1",
  v: 8,
  events: [
    { type: "pageview", path: "/", t: 900 },
    { type: "click", path: "/", clickText: "Buy", t: 400 },
    { type: "engagement", path: "/", durationMs: 5000, isExit: true, t: 0 },
  ],
});
check("batch accepted", status === 204, `status ${status}`);
check("batch writes every event", inserted.length === 3, `wrote ${inserted.length}`);
check("batch bills every event", meter.counted === 3, `counted ${meter.counted}`);
check("batch keeps types", inserted.map((d) => d.type).join(",") === "pageview,click,engagement",
  inserted.map((d) => d.type).join(","));

// The point of the `t` offset: events held in one batch must not all land on
// the flush instant, or the timeline flattens.
const times = inserted.map((d) => d.ts.getTime());
check("batch backdates by offset", times[0] < times[2], `${times[0]} vs ${times[2]}`);
check("batch spans ~900ms", times[2] - times[0] >= 850 && times[2] - times[0] <= 950,
  `${times[2] - times[0]}ms`);

// --- guards ---
reset();
status = await send({ v: 8, events: [{ type: "pageview" }] });
check("batch without siteId rejected", status === 400, `status ${status}`);

reset();
status = await send({ siteId: "s1", v: 8, events: [] });
check("empty batch is a no-op", status === 204 && inserted.length === 0, `wrote ${inserted.length}`);

reset();
status = await send({
  siteId: "s1", v: 8,
  events: Array.from({ length: 80 }, () => ({ type: "click" })),
});
check("oversized batch capped at 50", inserted.length === 50, `wrote ${inserted.length}`);

reset();
status = await send({ siteId: "s1", v: 8, events: [{ type: "pageview" }, null, "junk"] });
check("batch survives junk entries", status === 204 && inserted.length === 1, `wrote ${inserted.length}`);

// A forged offset must not write an event into the future or beyond retention.
reset();
await send({ siteId: "s1", v: 8, events: [{ type: "pageview", t: -5000 }] });
check("negative offset clamped to now", inserted[0].ts.getTime() <= Date.now() + 1000);

reset();
await send({ siteId: "s1", v: 8, events: [{ type: "pageview", t: 999999999 }] });
const backdated = Date.now() - inserted[0].ts.getTime();
check("huge offset clamped to 6h", backdated <= 6 * 60 * 60 * 1000 + 1000, `${backdated}ms`);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
