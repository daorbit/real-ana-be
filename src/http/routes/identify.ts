import { Router } from "express";
import { Event } from "../../modules/analytics/models/Event.js";
import { canIngest } from "../../modules/billing/event-quota.js";

const router = Router();

const str = (v: unknown, max = 120): string =>
  typeof v === "string" ? v.slice(0, max) : "";

/**
 * Called by the app SDK once, right after signup/login, to attach the
 * tenant's own user id to everything the install did before it existed —
 * onboarding screens, signup_started, whatever fired while the visitor was
 * still anonymous.
 *
 * A backfill, not an ongoing link: after this call the SDK sends `appUserId`
 * directly on every event, so the same install re-logging-in later re-runs
 * this and is a no-op (installId's events already carry the same appUserId).
 */
router.post("/", async (req, res) => {
  try {
    const { siteId, installId, appUserId } = req.body ?? {};
    if (!siteId) return res.status(400).json({ error: "siteId required" });
    if (!installId) return res.status(400).json({ error: "installId required" });
    if (!appUserId) return res.status(400).json({ error: "appUserId required" });

    const { allowed, workspaceId } = await canIngest(String(siteId));
    if (!workspaceId) return res.status(404).json({ error: "unknown siteId" });
    if (!allowed) return res.status(429).json({ error: "event quota exhausted" });

    await Event.updateMany(
      { siteId, installId: str(installId), appUserId: "" },
      { appUserId: str(appUserId) },
    );

    res.status(204).end();
  } catch {
    res.status(500).json({ error: "identify failed" });
  }
});

export default router;
