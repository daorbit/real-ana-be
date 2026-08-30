/**
 * Drives tracker.js in a real browser against a stub collector.
 *
 * The batching rules only hold if the browser actually behaves as assumed:
 * that a queued event survives a click, that the exit paths drain the queue
 * before the page goes, and that nothing is lost on the way. Asserting that
 * from the source text proves nothing, so this runs the real script.
 *
 * Needs Playwright's chromium, which lives in the frontend package:
 *   node scripts/check-tracker-batch.mjs
 */

import express from "express";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../real-ana-fe/package.json", import.meta.url),
);
const { chromium } = require("playwright");

// --- stub collector: records what the tracker sends, stores nothing ---
const received = [];
const app = express();
app.use(express.text({ type: "*/*" }));

app.post("/api/collect", (req, res) => {
  try {
    received.push({ at: Date.now(), body: JSON.parse(req.body) });
  } catch {
    received.push({ at: Date.now(), body: null });
  }
  res.status(204).end();
});

app.get("/tracker.js", (_req, res) => {
  res.type("application/javascript").sendFile(
    new URL("../public/tracker.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  );
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><body>
    <h1>batch test</h1>
    <button id="a">Alpha</button>
    <button id="b">Beta</button>
    <button id="c">Gamma</button>
    <script src="/tracker.js" data-site="s_test"></script>
  </body></html>`);
});

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return console.log(`ok   ${name}`);
  failures++;
  console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
};

const allEvents = () =>
  received.flatMap((r) => (r.body?.events ? r.body.events : r.body ? [r.body] : []));

const browser = await chromium.launch();
const page = await browser.newPage();

// --- a pageview plus three clicks should not be four requests ---
received.length = 0;
await page.goto(base, { waitUntil: "load" });
await page.click("#a");
await page.click("#b");
await page.click("#c");

// Nothing should have gone out yet: the batch window is 1000ms.
const immediate = received.length;
check("events are held, not sent per-event", immediate === 0, `${immediate} request(s) already sent`);

await page.waitForTimeout(1400);

const afterFlush = received.length;
check("one request carries the batch", afterFlush === 1, `${afterFlush} requests`);

const batch = received[0]?.body;
check("batch uses the envelope shape", !!batch?.events && batch.siteId === "s_test" && batch.v === 8,
  JSON.stringify(batch)?.slice(0, 120));

const types = (batch?.events ?? []).map((e) => e.type);
check("batch holds the pageview and all three clicks",
  types.filter((t) => t === "pageview").length === 1 && types.filter((t) => t === "click").length === 3,
  types.join(","));

// Each event should report its own moment, not the flush instant.
const offsets = (batch?.events ?? []).map((e) => e.t);
check("every event carries an age offset", offsets.every((t) => typeof t === "number"), offsets.join(","));
check("offsets differ across the batch", new Set(offsets).size > 1, offsets.join(","));
check("pageview is the oldest in the batch", offsets[0] === Math.max(...offsets), offsets.join(","));

// --- the batch cap forces an early send ---
received.length = 0;
await page.goto(base, { waitUntil: "load" });
for (let n = 0; n < 12; n++) await page.click("#a");
await page.waitForTimeout(200); // well inside the 1000ms window
check("hitting the cap sends without waiting for the timer", received.length >= 1,
  `${received.length} requests after 200ms`);
await page.waitForTimeout(1400);

// --- the exit path: a queued event must not die with the page ---
received.length = 0;
await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(1400); // let the pageview batch go
received.length = 0;
await page.click("#a"); // queued, timer still running
await page.goto(base + "/?second", { waitUntil: "load" }); // navigate away immediately
await page.waitForTimeout(600);

const exitEvents = allEvents();
check("a click queued at navigation still arrives",
  exitEvents.some((e) => e.type === "click"),
  exitEvents.map((e) => e.type).join(","));
check("the engagement record still arrives",
  exitEvents.some((e) => e.type === "engagement"),
  exitEvents.map((e) => e.type).join(","));

// --- nothing is lost across a full session ---
// A fresh page, and the load settled before the window opens: navigating in
// place would also report the previous page's exit, which is correct but not
// what this is measuring.
await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(1400);
received.length = 0;

await page.click("#a");
await page.click("#b");
await page.waitForTimeout(1400);
await page.close(); // fires pagehide, draining anything still queued
await new Promise((r) => setTimeout(r, 400));

const session = allEvents();
check("session records no stray pageview", session.filter((e) => e.type === "pageview").length === 0,
  session.map((e) => e.type).join(","));
check("session records both clicks", session.filter((e) => e.type === "click").length === 2,
  session.map((e) => e.type).join(","));

const requests = received.length;
console.log(`\n     ${session.length} events delivered in ${requests} request(s)`);
check("batching actually reduced request count", requests < session.length,
  `${requests} requests for ${session.length} events`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
