import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Dashboard, DASHBOARD_RANGES, type DashboardRange } from "../../modules/dashboards/models/Dashboard.js";
import { parseLayout } from "../../modules/workspace/layout.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const MAX_DASHBOARDS = 50;

type DashboardDoc = InstanceType<typeof Dashboard>;

function present(d: DashboardDoc) {
  return {
    id: d.id,
    name: d.get("name"),
    description: d.get("description") ?? "",
    template: d.get("template") ?? "blank",
    range: d.get("range"),
    layout: d.get("layout") ?? [],
    createdAt: d.get("createdAt"),
    updatedAt: d.get("updatedAt"),
  };
}

function readRange(raw: unknown): DashboardRange | undefined {
  return DASHBOARD_RANGES.includes(raw as DashboardRange) ? (raw as DashboardRange) : undefined;
}

async function findDashboard(workspaceId: string, id: string) {
  if (!isValidObjectId(id)) return null;
  return Dashboard.findOne({ _id: id, workspaceId });
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;
    const dashboards = await Dashboard.find({ workspaceId: ws.id }).sort({ updatedAt: -1 });
    res.json(dashboards.map(present));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;
    const dashboard = await findDashboard(ws.id, String(req.params.id));
    if (!dashboard) return res.status(404).json({ error: "dashboard not found" });
    res.json(present(dashboard));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "name required" });

    const layout = req.body?.layout === undefined ? [] : parseLayout(req.body.layout);
    if (!layout) return res.status(400).json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });

    if ((await Dashboard.countDocuments({ workspaceId: ws.id })) >= MAX_DASHBOARDS) {
      return res.status(409).json({ error: `a workspace can hold up to ${MAX_DASHBOARDS} dashboards` });
    }

    const dashboard = await Dashboard.create({
      workspaceId: ws.id,
      name,
      description: String(req.body?.description ?? "").trim().slice(0, 240),
      template: String(req.body?.template ?? "blank").slice(0, 40),
      range: readRange(req.body?.range) ?? "7d",
      layout,
      createdBy: req.userId,
    });
    res.status(201).json(present(dashboard));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    const dashboard = await findDashboard(ws.id, String(req.params.id));
    if (!dashboard) return res.status(404).json({ error: "dashboard not found" });

    const body = req.body ?? {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "name required" });
      dashboard.set("name", name);
    }
    if (body.description !== undefined) {
      dashboard.set("description", String(body.description).trim().slice(0, 240));
    }
    if (body.range !== undefined) {
      const range = readRange(body.range);
      if (!range) return res.status(400).json({ error: "range must be 24h, 7d or 30d" });
      dashboard.set("range", range);
    }
    if (body.layout !== undefined) {
      const layout = parseLayout(body.layout);
      if (!layout) return res.status(400).json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });
      dashboard.set("layout", layout);
    }

    await dashboard.save();
    res.json(present(dashboard));
  }),
);

router.post(
  "/:id/duplicate",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    const source = await findDashboard(ws.id, String(req.params.id));
    if (!source) return res.status(404).json({ error: "dashboard not found" });

    if ((await Dashboard.countDocuments({ workspaceId: ws.id })) >= MAX_DASHBOARDS) {
      return res.status(409).json({ error: `a workspace can hold up to ${MAX_DASHBOARDS} dashboards` });
    }

    const copy = await Dashboard.create({
      workspaceId: ws.id,
      name: `${source.get("name")} (copy)`.slice(0, 80),
      description: source.get("description"),
      template: source.get("template"),
      range: source.get("range"),
      layout: source.get("layout"),
      createdBy: req.userId,
    });
    res.status(201).json(present(copy));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    const dashboard = await findDashboard(ws.id, String(req.params.id));
    if (!dashboard) return res.status(404).json({ error: "dashboard not found" });
    await dashboard.deleteOne();
    res.status(204).end();
  }),
);

export default router;
