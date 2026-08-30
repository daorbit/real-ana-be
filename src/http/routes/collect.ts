import { Router } from "express";
import { Event } from "../../modules/analytics/models/Event.js";
import { Site } from "../../modules/analytics/models/Site.js";
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

    /**
     * One event or many.
     *
     * Tracker v8+ posts `{ siteId, v, events: [...] }`; every earlier version
     * posts a single flat event. Both shapes are read here so an embedded site
     * that never updates its snippet keeps reporting unchanged.
     */
    const batched: any[] | null = Array.isArray(body?.events) ? body.events : null;
    const items: any[] = batched ?? [body];

    const siteId = body?.siteId;
    if (!siteId) return res.status(400).json({ error: "siteId required" });
    if (!items.length) return res.status(204).end();

    /**
     * Existence and quota in one cached check.
     *
     * This replaces an unconditional `Site.findOne` per event: the decision is
     * memoised per site, so a site comfortably inside its allowance costs no
     * database read at all, and an unknown key is cached as a rejection rather
     * than re-querying on every junk beacon.
     */
    const { allowed, workspaceId } = await canIngest(String(siteId));
    if (!workspaceId) return res.status(404).json({ error: "unknown siteId" });
    if (!allowed) {
      // 429, not 402: this is the tracker on a visitor's browser, not the
      // customer's dashboard. Nobody on this end can act on a billing error,
      // and a well-behaved beacon should simply stop rather than retry.
      return res.status(429).json({ error: "event quota exhausted" });
    }

    // Record the tracker version so the dashboard can flag sites still running
    // a script that predates the metrics it now shows. Only ever moves forward:
    // a stale tab running the old script must not undo a completed upgrade.
    //
    // The "only forward" rule is now the query's condition rather than a
    // comparison against a document we just read, since the quota check above
    // no longer fetches one. Same guarantee, and it holds under concurrency
    // where a read-then-write did not.
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

    const docs = items
      .slice(0, MAX_BATCH)
      .filter((item) => item && typeof item === "object")
      .map((item) => buildEvent(item, String(siteId), shared));

    if (!docs.length) return res.status(204).end();

    // One round trip for the whole batch. `ordered: false` so a single bad
    // document does not discard the ones after it — a partial write is the
    // right outcome for telemetry, where losing the batch loses real traffic.
    await Event.insertMany(docs, { ordered: false });

    // Counted only once the events are actually stored, so a failed write is
    // not billed. Awaited before the response: a serverless invocation can be
    // frozen the instant the response goes out, and anything left to do after
    // that may never happen.
    await countEvents(workspaceId, docs.length);

    // 204 keeps the beacon lightweight
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "collect failed" });
  }
});

export default router;
