import { Router } from "express";
import { Event } from "../../modules/analytics/models/Event.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { HeatmapClick } from "../../modules/analytics/models/HeatmapClick.js";
import { visitorHash, clientIp, country, parseUA } from "../../modules/analytics/enrich.js";
import { canIngest, countEvents } from "../../modules/billing/event-quota.js";

const router = Router();

// Clamp so a hostile or buggy client can't poison the aggregates.
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 min on one page is the ceiling
const num = (v: unknown, max = 100_000): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
};
const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.slice(0, max) : "";
const pct = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
};

/**
 * Core Web Vitals from tracker v5+.
 *
 * Each metric is clamped to a plausible ceiling and absent values stay null
 * rather than becoming 0 — a browser that cannot measure INP must not be
 * recorded as having a perfect INP, which would drag every percentile down.
 */
const vitals = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;

  // A metric is only stored when it arrived as a finite, non-negative number.
  const metric = (value: unknown, max: number): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, max);
  };

  const out = {
    lcp: metric(v.lcp, 120_000),
    cls: metric(v.cls, 100),
    inp: metric(v.inp, 120_000),
    fcp: metric(v.fcp, 120_000),
    ttfb: metric(v.ttfb, 120_000),
  };

  // Nothing usable in the payload — leave the subdocument off entirely.
  return Object.values(out).some((x) => x !== null) ? out : undefined;
};

/**
 * How many events one request may carry.
 *
 * Tracker v8+ batches deferrable events, so a normal request holds a handful.
 * The cap is what stops a hostile client turning one beacon into an unbounded
 * write, and events past it are dropped rather than failing the whole batch —
 * a partial record beats none.
 */
const MAX_BATCH = 50;

/**
 * Build the Event document for one item in a request.
 *
 * Split out of the handler so a single event and a batched one go through
 * exactly the same shaping and clamping — the batch path must not become a
 * second, subtly different collector.
 */
function buildEvent(
  body: any,
  siteId: string,
  shared: { vh: string; device: string; os: string; browser: string; country: string },
) {
  return {
    siteId,
    type: body.type ?? "pageview",
    name: str(body.name, 80),
    path: str(body.path, 300) || "/",
    hostname: str(body.hostname, 253),
    referrer: str(body.referrer, 300),

    clickText: str(body.clickText, 120),
    clickTag: str(body.clickTag, 20),
    clickId: str(body.clickId, 120),
    clickHref: str(body.clickHref, 300),
    visitorHash: shared.vh,
    // Identified-tracking fields — absent on anonymous (landing page) events.
    appUserId: str(body.appUserId, 120),
    installId: str(body.installId, 120),
    source: str(body.source, 120),
    destination: str(body.destination, 120),
    // Prefer the tracker's session id; fall back to the daily visitor hash.
    sessionId: str(body.sessionId, 60) || shared.vh,

    device: shared.device,
    os: shared.os,
    browser: shared.browser,
    country: shared.country,
    language: str(body.language, 20),
    timezone: str(body.timezone, 60),
    screenW: num(body.screenW, 20000),
    screenH: num(body.screenH, 20000),
    viewportW: num(body.viewportW, 20000),
    viewportH: num(body.viewportH, 20000),

    isEntry: !!body.isEntry,
    isExit: !!body.isExit,
    entryPath: str(body.entryPath, 300),

    durationMs: num(body.durationMs, MAX_DURATION_MS),
    bounce: !!body.bounce,
    scrollDepth: num(body.scrollDepth, 100),
    vitals: vitals(body.vitals),

    utm: {
      source: str(body.utm?.source, 80),
      medium: str(body.utm?.medium, 80),
      campaign: str(body.utm?.campaign, 80),
      term: str(body.utm?.term, 120),
      content: str(body.utm?.content, 120),
      clickId: str(body.utm?.clickId, 200),
      landingReferrer: str(body.utm?.landingReferrer, 300),
    },
    props: body.props,

    // Each event carries the moment it was queued on the client, so a batch
    // held for a second does not stamp every event with the flush time and
    // flatten the timeline. Clamped to now: a client with a skewed clock or a
    // forged timestamp must not write events into the future, and anything
    // older than the retention window is nudged forward rather than trusted.
    ts: eventTime(body.t),
  };
}


function buildHeatmapPoint(
  body: any,
  siteId: string,
  device: string,
): any {
  return {
    siteId,
    type: body.type === "heat_scroll" ? "scroll" : "click",
    path: str(body.path, 300) || "/",
    xPct: pct(body.xPct),
    yPct: pct(body.yPct),
    scrollPct: pct(body.scrollPct),
    device,
    viewportW: num(body.viewportW, 20000),
    viewportH: num(body.viewportH, 20000),
    sessionId: str(body.sessionId, 60),
    ts: eventTime(body.t),
  };
}

/**
 * When an event happened, from the client's `t` offset.
 *
 * The tracker sends milliseconds-ago rather than an absolute timestamp, so a
 * device with a wrong clock still lands in the right place: the offset is
 * relative to a request whose arrival time the server knows.
 */
const MAX_BACKDATE_MS = 6 * 60 * 60 * 1000; // 6h — longer than any held batch
function eventTime(rawOffset: unknown): Date {
  const now = Date.now();
  const ago = Number(rawOffset);
  if (!Number.isFinite(ago) || ago <= 0) return new Date(now);
  return new Date(now - Math.min(ago, MAX_BACKDATE_MS));
}

// Public ingest endpoint. Called by tracker.js embedded on customer sites.
router.post("/", async (req, res) => {
  try {
    // Body arrives as JSON (fetch) or as a raw text/plain string (sendBeacon).
    let body: any = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "invalid body" });
      }
    }


    const batched: any[] | null = Array.isArray(body?.events) ? body.events : null;
    const items: any[] = batched ?? [body];

    const siteId = body?.siteId;
    if (!siteId) return res.status(400).json({ error: "siteId required" });
    if (!items.length) return res.status(204).end();


    const { allowed, workspaceId } = await canIngest(String(siteId));
    if (!workspaceId) return res.status(404).json({ error: "unknown siteId" });
    if (!allowed) {

      return res.status(429).json({ error: "event quota exhausted" });
    }

 
    const reported = num(body.v, 100);
    if (reported > 1) {
      await Site.updateOne(
        { siteId, trackerVersion: { $lt: reported } },
        { trackerVersion: reported },
      );
    }

    const ua = req.headers["user-agent"] ?? "";
    const ip = clientIp(req);
    const vh = visitorHash(ip, ua, siteId);
    const { device, os, browser } = parseUA(ua);

    // Derived from the request, so every event in a batch shares them — one
    // UA parse and one geo lookup per request rather than per event.
    const shared = { vh, device, os, browser, country: country(req) };

    const validItems = items.slice(0, MAX_BATCH).filter((item) => item && typeof item === "object");

    const heatmapItems = validItems.filter((item) => item.type === "heat_click" || item.type === "heat_scroll");
    const docs = validItems
      .filter((item) => item.type !== "heat_click" && item.type !== "heat_scroll")
      .map((item) => buildEvent(item, String(siteId), shared));
    const heatmapDocs = heatmapItems.map((item) => buildHeatmapPoint(item, String(siteId), shared.device));

    if (!docs.length && !heatmapDocs.length) return res.status(204).end();


    const writes: Promise<unknown>[] = [];
    if (docs.length) writes.push(Event.insertMany(docs, { ordered: false }));
    if (heatmapDocs.length) writes.push(HeatmapClick.insertMany(heatmapDocs, { ordered: false }));
    await Promise.all(writes);


    await countEvents(workspaceId, docs.length + heatmapDocs.length);

    // 204 keeps the beacon lightweight
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "collect failed" });
  }
});

export default router;
