import { Router, Request, Response } from "express";
import { unsubscribe } from "../../modules/campaigns/suppression.service.js";
import { readUnsubscribeToken } from "../../modules/campaigns/unsubscribe-token.js";
import { unsubscribeConfirmPage, unsubscribeDonePage, unsubscribeInvalidPage } from "../views/unsubscribe-page.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router();

router.get("/unsubscribe", (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  const valid = readUnsubscribeToken(req.query.t);
  res.status(valid ? 200 : 400).type("html").send(valid ? unsubscribeConfirmPage(String(req.query.t)) : unsubscribeInvalidPage());
});

router.post(
  "/unsubscribe",
  asyncHandler(async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const claims = readUnsubscribeToken(req.query.t);
    if (!claims) return res.status(400).type("html").send(unsubscribeInvalidPage());
    await unsubscribe(claims.workspaceId, claims.campaignId, claims.email);
    res.type("html").send(unsubscribeDonePage());
  }),
);

export default router;
