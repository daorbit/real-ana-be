import { Router } from "express";
import { Event } from "../models/Event.js";
import { Site } from "../models/Site.js";
import { visitorHash, clientIp, country, parseUA } from "../enrich.js";

const router = Router();

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

    const { siteId, type, name, path, referrer, utm } = body ?? {};
    if (!siteId) return res.status(400).json({ error: "siteId required" });

    // Verify site exists (reject unknown keys to avoid junk data)
    const site = await Site.exists({ siteId });
    if (!site) return res.status(404).json({ error: "unknown siteId" });

    const ua = req.headers["user-agent"] ?? "";
    const ip = clientIp(req);
    const vh = visitorHash(ip, ua, siteId);
    const { device, os, browser } = parseUA(ua);

    await Event.create({
      siteId,
      type: type ?? "pageview",
      name,
      path: path ?? "/",
      referrer: referrer ?? "",
      visitorHash: vh,
      sessionId: vh, // MVP: session == daily visitor hash
      device,
      os,
      browser,
      country: country(req),
      utm: {
        source: utm?.source ?? "",
        medium: utm?.medium ?? "",
        campaign: utm?.campaign ?? "",
      },
      ts: new Date(),
    });

    // 204 keeps beacon lightweight
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "collect failed" });
  }
});

export default router;
