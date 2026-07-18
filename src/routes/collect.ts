import { Router } from "express";
import { Event } from "../models/Event.js";
import { Site } from "../models/Site.js";
import { visitorHash, clientIp, country, parseUA } from "../enrich.js";

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

    const { siteId, type, name } = body ?? {};
    if (!siteId) return res.status(400).json({ error: "siteId required" });

    // Verify site exists (reject unknown keys to avoid junk data)
    const site = await Site.findOne({ siteId }).select("trackerVersion");
    if (!site) return res.status(404).json({ error: "unknown siteId" });

    // Record the tracker version so the dashboard can flag sites still running
    // a script that predates the metrics it now shows. Only ever moves forward:
    // a stale tab running the old script must not undo a completed upgrade.
    const reported = num(body.v, 100);
    if (reported > (site.trackerVersion ?? 1)) {
      await Site.updateOne({ siteId }, { trackerVersion: reported });
    }

    const ua = req.headers["user-agent"] ?? "";
    const ip = clientIp(req);
    const vh = visitorHash(ip, ua, siteId);
    const { device, os, browser } = parseUA(ua);

    await Event.create({
      siteId,
      type: type ?? "pageview",
      name: str(name, 80),
      path: str(body.path, 300) || "/",
      hostname: str(body.hostname, 253),
      referrer: str(body.referrer, 300),

      clickText: str(body.clickText, 120),
      clickTag: str(body.clickTag, 20),
      clickId: str(body.clickId, 120),
      clickHref: str(body.clickHref, 300),
      visitorHash: vh,
      // Prefer the tracker's session id; fall back to the daily visitor hash.
      sessionId: str(body.sessionId, 60) || vh,

      device,
      os,
      browser,
      country: country(req),
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

      utm: {
        source: str(body.utm?.source, 80),
        medium: str(body.utm?.medium, 80),
        campaign: str(body.utm?.campaign, 80),
      },
      props: body.props,

      ts: new Date(),
    });

    // 204 keeps the beacon lightweight
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "collect failed" });
  }
});

export default router;
