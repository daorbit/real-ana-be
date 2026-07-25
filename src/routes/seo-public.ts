import { Router, Request, Response } from "express";
import { SeoReport } from "../models/SeoReport.js";
import { publicSeoReport } from "../lib/seo-share.js";

/**
 * Public, unauthenticated read-only SEO audit reports.
 *
 * The share token is the entire credential, so this router is deliberately
 * narrow: one route, and a response assembled field by field (in
 * `publicSeoReport`) rather than spread from the stored report. A section the
 * owner did not publish is dropped there, on the server — it never reaches the
 * network at all.
 *
 * Never exposed: the site id (it is the public tracking key — leaking one lets
 * anyone post events into the customer's analytics), workspace id, owner
 * identity, or any report the owner has not explicitly shared.
 */
const router = Router();

router.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Cheap shape check before touching the database, so a flood of junk tokens
  // costs nothing to reject.
  if (!token.startsWith("pk_seo_") || token.length > 80) {
    return res.status(404).json({ error: "not found" });
  }

  const report = await SeoReport.findOne({ shareToken: token, shareEnabled: true });
  // A disabled or unknown token gets the same 404 — distinguishing them would
  // confirm a token exists, which a guesser can use.
  if (!report) return res.status(404).json({ error: "not found" });

  // Count the open, fire-and-forget: a failed counter must never stop the page
  // rendering. Only the first load counts — panel/range switches re-fetch, and
  // counting those turns one reader into several "views".
  if (req.query.count === "1") {
    SeoReport.updateOne(
      { _id: report.id },
      { $inc: { shareViews: 1 }, $set: { shareLastViewedAt: new Date() } }
    ).catch(() => {});
  }

  res.json(publicSeoReport(report));
});

export default router;
