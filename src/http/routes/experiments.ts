import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Site } from "../../modules/analytics/models/Site.js";
import { Experiment } from "../../modules/experiments/models/Experiment.js";
import { parseExperimentDraft } from "../../modules/experiments/experiment-draft.js";
import { keyTaken, listExperiments, presentExperiment, resultsInput, runningLimit } from "../../modules/experiments/experiments.service.js";
import { experimentResults } from "../../modules/experiments/results.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const NOT_FOUND = { error: "test not found" };

async function requireExperimentsWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "experiments")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.experiments });
    return null;
  }
  return ws;
}

function findOwned(workspaceId: string, id: string) {
  if (!isValidObjectId(id)) return Promise.resolve(null);
  return Experiment.findOne({ _id: id, workspaceId });
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res);
    if (!ws) return;
    res.json(await listExperiments(ws.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    const draft = parseExperimentDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const [site, taken] = await Promise.all([
      Site.exists({ siteId: draft.siteId, workspaceId: ws.id }),
      keyTaken(draft.siteId, draft.key),
    ]);
    if (!site) return res.status(400).json({ error: "site not found" });
    if (taken) return res.status(409).json({ error: "Another test on this site already uses that key." });

    const doc = await Experiment.create({ workspaceId: ws.id, ...draft, createdBy: req.userId });
    res.status(201).json(presentExperiment(doc));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res);
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    const experiment = presentExperiment(doc);
    res.json({ experiment, results: await experimentResults(resultsInput(experiment)) });
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    const id = String(req.params.id);
    const draft = parseExperimentDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const [doc, site, taken] = await Promise.all([
      findOwned(ws.id, id),
      Site.exists({ siteId: draft.siteId, workspaceId: ws.id }),
      keyTaken(draft.siteId, draft.key, id),
    ]);
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (!site) return res.status(400).json({ error: "site not found" });
    if (taken) return res.status(409).json({ error: "Another test on this site already uses that key." });
    if (doc.get("status") === "running") return res.status(409).json({ error: "Pause the test before changing it." });
    if (doc.get("status") === "ended") return res.status(409).json({ error: "An ended test cannot be changed. Duplicate it instead." });

    doc.set(draft);
    await doc.save();
    res.json(presentExperiment(doc));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json(NOT_FOUND);
    const result = await Experiment.deleteOne({ _id: req.params.id, workspaceId: ws.id });
    if (!result.deletedCount) return res.status(404).json(NOT_FOUND);
    res.status(204).end();
  }),
);

router.post(
  "/:id/start",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    const [doc, limits] = await Promise.all([findOwned(ws.id, String(req.params.id)), runningLimit(ws.id)]);
    if (!doc) return res.status(404).json(NOT_FOUND);
    const status = doc.get("status");
    if (status === "ended") return res.status(409).json({ error: "An ended test cannot be restarted. Duplicate it instead." });
    if (status === "running") return res.json(presentExperiment(doc));
    if (limits.running >= limits.limit) {
      return planLimit(
        res,
        `The ${limits.plan} plan runs ${limits.limit} A/B ${limits.limit === 1 ? "test" : "tests"} at a time — pause one or upgrade`,
        { kind: "experiments", label: "Running A/B tests", used: limits.running, quota: limits.limit, plan: limits.plan },
      );
    }
    doc.set({ status: "running", startedAt: doc.get("startedAt") ?? new Date(), endedAt: null });
    await doc.save();
    res.json(presentExperiment(doc));
  }),
);

router.post(
  "/:id/pause",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") !== "running") return res.status(409).json({ error: "Only a running test can be paused." });
    doc.set({ status: "paused" });
    await doc.save();
    res.json(presentExperiment(doc));
  }),
);

router.post(
  "/:id/end",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireExperimentsWorkspace(req, res, "editor");
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") === "ended") return res.json(presentExperiment(doc));
    if (doc.get("status") === "draft") return res.status(409).json({ error: "A draft test has nothing to end. Delete it instead." });

    const keys = presentExperiment(doc).variants.map((v) => v.key);
    const winner = typeof req.body?.winner === "string" && keys.includes(req.body.winner) ? req.body.winner : "";
    doc.set({ status: "ended", endedAt: new Date(), winner, keepWinner: Boolean(winner) && req.body?.keepWinner === true });
    await doc.save();
    res.json(presentExperiment(doc));
  }),
);

export default router;
