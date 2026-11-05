import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { publicBrand } from "../../modules/branding/public-brand.js";
import { Campaign } from "../../modules/campaigns/models/Campaign.js";
import { CampaignRecipient } from "../../modules/campaigns/models/CampaignRecipient.js";
import { isEmailAddress, parseCampaignDraft, sendProblem, type CampaignContact } from "../../modules/campaigns/campaign-draft.js";
import { campaignHtml, campaignText, personalize, unsubscribeHeaders } from "../../modules/campaigns/campaign-email.js";
import { emailDelivery, leadSources, sendEmails } from "../../modules/campaigns/campaign-delivery.js";
import {
  campaignAudience,
  campaignUsage,
  deleteCampaign,
  listCampaigns,
  prepareRecipients,
  presentCampaign,
} from "../../modules/campaigns/campaigns.service.js";
import { unsubscribeUrl } from "../../modules/campaigns/unsubscribe-token.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { FormsServiceError } from "../../infra/http-client/forms-service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const NOT_FOUND = { error: "campaign not found" };
const FAILURES_LIMIT = 50;
const TESTS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const SAMPLE_NAME = "Alex";

async function requireCampaignsWorkspace(req: AuthedRequest, res: Response, minimum: WorkspaceRole = "editor") {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "campaigns")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.campaigns });
    return null;
  }
  return ws;
}

function findOwned(workspaceId: string, id: string) {
  if (!isValidObjectId(id)) return Promise.resolve(null);
  return Campaign.findOne({ _id: id, workspaceId });
}

function sendFormsError(res: Response, e: unknown): boolean {
  if (!(e instanceof FormsServiceError)) return false;
  res.status(e.status).json({ error: "The email service could not be reached. Try again in a moment." });
  return true;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res, "viewer");
    if (!ws) return;
    res.json(await listCampaigns(ws.id));
  }),
);

router.get(
  "/sources",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    try {
      const [forms, delivery] = await Promise.all([leadSources(ws.id), emailDelivery(ws.id)]);
      res.json({ forms, delivery });
    } catch (e) {
      if (!sendFormsError(res, e)) throw e;
    }
  }),
);

router.post(
  "/preview",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const draft = parseCampaignDraft({ ...req.body, name: "Preview" });
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const brand = await publicBrand(ws.id);
    res.json({ html: campaignHtml(draft, { name: SAMPLE_NAME, unsubscribeUrl: "#", preview: true }, brand, String(ws.get("name") ?? "")) });
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const draft = parseCampaignDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const doc = await Campaign.create({ workspaceId: ws.id, createdBy: req.userId, ...draft });
    res.status(201).json(presentCampaign(doc, true));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res, "viewer");
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    res.json(presentCampaign(doc, true));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const draft = parseCampaignDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") !== "draft") return res.status(409).json({ error: "Only a draft can be changed." });
    doc.set(draft);
    await doc.save();
    res.json(presentCampaign(doc, true));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (["sending", "preparing"].includes(doc.get("status") as string)) {
      return res.status(409).json({ error: "Pause the campaign before deleting it." });
    }
    await deleteCampaign(doc._id);
    res.status(204).end();
  }),
);

router.post(
  "/:id/audience",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    try {
      const [audience, usage] = await Promise.all([
        campaignAudience(ws.id, doc.get("formIds") as string[], doc.get("imported") as CampaignContact[]),
        campaignUsage(ws.id),
      ]);
      res.json({ total: audience.contacts.length, suppressed: audience.suppressed, usage });
    } catch (e) {
      if (!sendFormsError(res, e)) throw e;
    }
  }),
);

router.post(
  "/:id/test",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const to = req.body?.to;
    if (!isEmailAddress(to)) return res.status(400).json({ error: "Enter a valid address for the test." });
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    const content = presentCampaign(doc);
    const problem = sendProblem(content);
    if (problem) return res.status(400).json({ error: problem });
    if (await overRateLimit(`campaign-test:${ws.id}`, TESTS_PER_HOUR, HOUR_MS)) {
      return res.status(429).json({ error: "Too many test emails. Try again later." });
    }

    const brand = await publicBrand(ws.id);
    const workspaceName = String(ws.get("name") ?? "");
    const url = unsubscribeUrl({ workspaceId: ws.id, campaignId: content.id, email: to.trim().toLowerCase() });
    const info = { name: SAMPLE_NAME, unsubscribeUrl: url };
    try {
      const [result] = await sendEmails(ws.id, [
        {
          to: to.trim(),
          subject: `[Test] ${personalize(content.subject, SAMPLE_NAME)}`,
          html: campaignHtml(content, info, brand, workspaceName),
          text: campaignText(content, info, brand.name || workspaceName),
          headers: unsubscribeHeaders(url),
        },
      ]);
      if (!result?.ok) return res.status(502).json({ error: result?.error || "Your email provider refused the test." });
      res.json({ ok: true });
    } catch (e) {
      if (!sendFormsError(res, e)) throw e;
    }
  }),
);

router.post(
  "/:id/send",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: "Confirm these people agreed to hear from you." });
    }
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") !== "draft") return res.status(409).json({ error: "This campaign was already sent." });
    const problem = sendProblem(presentCampaign(doc));
    if (problem) return res.status(400).json({ error: problem });

    try {
      const [delivery, audience, usage] = await Promise.all([
        emailDelivery(ws.id),
        campaignAudience(ws.id, doc.get("formIds") as string[], doc.get("imported") as CampaignContact[]),
        campaignUsage(ws.id),
      ]);
      if (!delivery.connected) return res.status(409).json({ error: "Activate an email provider in Apps first." });
      if (!audience.contacts.length) return res.status(400).json({ error: "This campaign has nobody to send to." });
      if (usage.used + audience.contacts.length > usage.limit) {
        return planLimit(
          res,
          `The ${usage.plan} plan sends ${usage.limit} campaign emails a month, and this would go over it.`,
          { kind: "campaignEmails", label: "Campaign emails this month", used: usage.used, quota: usage.limit, plan: usage.plan },
        );
      }

      const claimed = await Campaign.findOneAndUpdate(
        { _id: doc._id, status: "draft" },
        { $set: { status: "preparing", consentConfirmedAt: new Date(), lastError: "" } },
        { new: true },
      );
      if (!claimed) return res.status(409).json({ error: "This campaign was already sent." });

      try {
        await prepareRecipients(ws.id, doc._id, audience.contacts);
      } catch (e) {
        await Promise.all([
          CampaignRecipient.deleteMany({ campaignId: doc._id }),
          Campaign.updateOne({ _id: doc._id }, { $set: { status: "draft" } }),
        ]);
        throw e;
      }

      const started = await Campaign.findOneAndUpdate(
        { _id: doc._id },
        { $set: { status: "sending", startedAt: new Date(), "counts.total": audience.contacts.length } },
        { new: true },
      );
      res.json(presentCampaign(started!, true));
    } catch (e) {
      if (!sendFormsError(res, e)) throw e;
    }
  }),
);

router.post(
  "/:id/pause",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") !== "sending") return res.status(409).json({ error: "Only a sending campaign can be paused." });
    doc.set({ status: "paused", lastError: "" });
    await doc.save();
    res.json(presentCampaign(doc, true));
  }),
);

router.post(
  "/:id/resume",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res);
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    if (doc.get("status") !== "paused") return res.status(409).json({ error: "Only a paused campaign can be resumed." });
    doc.set({ status: "sending", lastError: "" });
    await doc.save();
    res.json(presentCampaign(doc, true));
  }),
);

router.get(
  "/:id/failures",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireCampaignsWorkspace(req, res, "viewer");
    if (!ws) return;
    const doc = await findOwned(ws.id, String(req.params.id));
    if (!doc) return res.status(404).json(NOT_FOUND);
    const rows = await CampaignRecipient.find({ campaignId: doc._id, status: "failed" })
      .select("email error")
      .limit(FAILURES_LIMIT)
      .lean();
    res.json({ failures: rows.map((row) => ({ email: row.email, error: row.error ?? "" })) });
  }),
);

export default router;
