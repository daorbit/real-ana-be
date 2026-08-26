import { Router } from "express";
import { Event } from "../../modules/analytics/models/Event.js";
import { canIngest, countEvent, maybeFlush } from "../../modules/billing/event-quota.js";

const router = Router();

const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.slice(0, max) : "";
 
router.post("/", async (req, res) => {
  try {
    let body: any = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "invalid body" });
      }
    }

    const { siteId, appUserId, action } = body ?? {};
    if (!siteId) return res.status(400).json({ error: "siteId required" });
    if (!appUserId) return res.status(400).json({ error: "appUserId required" });
    if (!action) return res.status(400).json({ error: "action required" });

    const { allowed, workspaceId } = await canIngest(String(siteId));
    if (!workspaceId) return res.status(404).json({ error: "unknown siteId" });
    if (!allowed) return res.status(429).json({ error: "event quota exhausted" });

    const src = str(body.src, 120);
    const dest = str(body.dest, 120);

    await Event.create({
      siteId: String(siteId),
      type: "custom",
      name: str(action, 80),
      appUserId: str(appUserId, 120),
      installId: str(body.installId, 120),
      source: src,
      destination: dest,
      path: dest || src || "/",
      sessionId: str(body.sessionId, 60) || str(appUserId, 60),
      props: body.props,
      ts: new Date(),
    });

    countEvent(workspaceId);
    await maybeFlush();

    res.status(204).end();
  } catch {
    res.status(500).json({ error: "track failed" });
  }
});

export default router;
