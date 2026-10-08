import { Router, Request, Response } from "express";
import { Embed } from "../../modules/dashboards/models/Embed.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { embedPayload, isEmbedTokenShape } from "../../modules/dashboards/embed.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { publicBrand } from "../../modules/branding/public-brand.js";

const router = Router();

router.get(
  "/:token",
  asyncHandler(async (req: Request, res: Response) => {
    const token = String(req.params.token ?? "");
    if (!isEmbedTokenShape(token)) return res.status(404).json({ error: "not found" });

    const embed = await Embed.findOne({ token, enabled: true });
    if (!embed) return res.status(404).json({ error: "not found" });

    const workspaceId = embed.get("workspaceId");
    const [ws, sites, brand] = await Promise.all([
      Workspace.findById(workspaceId).select("name"),
      Site.find({ workspaceId }).select("siteId"),
      publicBrand(String(workspaceId)),
    ]);
    if (!ws) return res.status(404).json({ error: "not found" });

    const owned = sites.map((s) => String(s.siteId));
    const chosen = (embed.get("sites") as string[] | undefined) ?? [];
    const siteIds = chosen.length ? owned.filter((id) => chosen.includes(id)) : owned;

    if (req.query.count === "1") {
      Embed.updateOne(
        { _id: embed.id },
        { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } },
      ).catch(() => {});
    }

    const range = String(embed.get("range"));
    const data = await embedPayload(String(embed.get("widget")), siteIds, range);

    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.json({
      name: embed.get("name"),
      widget: embed.get("widget"),
      range,
      theme: embed.get("theme"),
      workspace: ws.get("name"),
      brand,
      data,
    });
  }),
);

export default router;
