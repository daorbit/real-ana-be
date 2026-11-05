import { randomUUID } from "node:crypto";
import { publicBrand, type PublicBrand } from "../branding/public-brand.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { appEnabled } from "../workspace/apps.service.js";
import { cronDeadline } from "../../shared/utils/time-budget.js";
import { Campaign } from "./models/Campaign.js";
import { CampaignRecipient } from "./models/CampaignRecipient.js";
import { parseEmailDesign } from "./campaign-design.js";
import { campaignHtml, campaignText, unsubscribeHeaders, type CampaignContent } from "./campaign-email.js";
import { sendEmails, type OutgoingEmail } from "./campaign-delivery.js";
import { unsubscribeUrl } from "./unsubscribe-token.js";

const BATCH_SIZE = 40;
const ACTIVE_LIMIT = 20;
const STALE_MS = 15 * 60 * 1000;
const INTERRUPTED = "Sending was interrupted, so this email was not retried.";
const APP_OFF = "Campaigns was turned off, so sending paused.";

type Active = {
  id: unknown;
  workspaceId: string;
  workspaceName: string;
  brand: PublicBrand;
  content: CampaignContent;
};

type BatchOutcome = "sent" | "finished" | "paused" | "waiting";

async function pause(campaignId: unknown, reason: string): Promise<void> {
  await Campaign.updateOne({ _id: campaignId, status: "sending" }, { $set: { status: "paused", lastError: reason } });
}

async function recoverInterrupted(now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const abandoned = await Campaign.find({ status: "preparing", updatedAt: { $lt: staleBefore } }).select("_id").lean();
  const abandonedIds = abandoned.map((c) => c._id);

  await Promise.all([
    CampaignRecipient.updateMany(
      { status: "sending", claimedAt: { $lt: staleBefore } },
      { $set: { status: "failed", error: INTERRUPTED } },
    ),
    ...(abandonedIds.length
      ? [
          CampaignRecipient.deleteMany({ campaignId: { $in: abandonedIds } }),
          Campaign.updateMany({ _id: { $in: abandonedIds } }, { $set: { status: "draft" } }),
        ]
      : []),
  ]);
}

async function claimBatch(campaignId: unknown, now: Date) {
  const claim = randomUUID();
  const pending = await CampaignRecipient.find({ campaignId, status: "pending" }).select("_id").limit(BATCH_SIZE).lean();
  if (!pending.length) return [];

  await CampaignRecipient.updateMany(
    { _id: { $in: pending.map((row) => row._id) }, status: "pending" },
    { $set: { status: "sending", claim, claimedAt: now } },
  );
  return CampaignRecipient.find({ claim }).select("email name").lean();
}

function buildEmail(active: Active, recipient: { email: string; name?: string | null }): OutgoingEmail {
  const url = unsubscribeUrl({ workspaceId: active.workspaceId, campaignId: String(active.id), email: recipient.email });
  const info = { name: recipient.name ?? "", unsubscribeUrl: url };
  return {
    to: recipient.email,
    subject: active.content.subject,
    html: campaignHtml(active.content, info, active.brand, active.workspaceName),
    text: campaignText(active.content, info, active.brand.name || active.workspaceName),
    headers: unsubscribeHeaders(url),
  };
}

async function finishIfDone(campaignId: unknown): Promise<boolean> {
  const open = await CampaignRecipient.exists({ campaignId, status: { $in: ["pending", "sending"] } });
  if (open) return false;
  await Campaign.updateOne({ _id: campaignId, status: "sending" }, { $set: { status: "sent", finishedAt: new Date(), lastError: "" } });
  return true;
}

async function releaseBatch(ids: unknown[]): Promise<void> {
  await CampaignRecipient.updateMany({ _id: { $in: ids } }, { $set: { status: "pending" }, $unset: { claim: 1, claimedAt: 1 } });
}

async function sendBatch(active: Active, now: Date): Promise<BatchOutcome> {
  const recipients = await claimBatch(active.id, now);
  if (!recipients.length) return (await finishIfDone(active.id)) ? "finished" : "waiting";

  const ids = recipients.map((row) => row._id);
  let results;
  try {
    results = await sendEmails(active.workspaceId, recipients.map((row) => buildEmail(active, row)));
  } catch (e) {
    await releaseBatch(ids);
    await pause(active.id, `The email service could not be reached: ${(e as Error).message}`);
    return "paused";
  }

  const sent = results.filter((result) => result.ok);
  if (!sent.length) {
    await releaseBatch(ids);
    await pause(active.id, results[0]?.error || "Your email provider refused these emails.");
    return "paused";
  }

  const byEmail = new Map(results.map((result) => [result.to, result]));
  await Promise.all([
    CampaignRecipient.bulkWrite(
      recipients.map((row) => {
        const result = byEmail.get(row.email as string);
        return {
          updateOne: {
            filter: { _id: row._id },
            update: result?.ok
              ? { $set: { status: "sent", sentAt: new Date() }, $unset: { claim: 1 } }
              : { $set: { status: "failed", error: result?.error ?? "No result from the email service." }, $unset: { claim: 1 } },
          },
        };
      }),
      { ordered: false },
    ),
    Campaign.updateOne(
      { _id: active.id },
      { $inc: { "counts.sent": sent.length, "counts.failed": recipients.length - sent.length } },
    ),
  ]);
  return "sent";
}

async function loadActive(): Promise<Active[]> {
  const campaigns = await Campaign.find({ status: "sending" })
    .select("workspaceId subject preheader mode design html senderAddress")
    .sort({ startedAt: 1 })
    .limit(ACTIVE_LIMIT)
    .lean();
  if (!campaigns.length) return [];

  const workspaceIds = [...new Set(campaigns.map((c) => String(c.workspaceId)))];
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name apps");
  const byId = new Map(workspaces.map((ws) => [String(ws._id), ws]));
  const brands = new Map(
    await Promise.all(workspaceIds.map(async (id) => [id, await publicBrand(id)] as const)),
  );

  const active: Active[] = [];
  for (const campaign of campaigns) {
    const id = String(campaign.workspaceId);
    const workspace = byId.get(id);
    if (!workspace || !appEnabled(workspace, "campaigns")) {
      await pause(campaign._id, APP_OFF);
      continue;
    }
    active.push({
      id: campaign._id,
      workspaceId: id,
      workspaceName: String(workspace.get("name") ?? ""),
      brand: brands.get(id)!,
      content: {
        subject: String(campaign.subject ?? ""),
        preheader: String(campaign.preheader ?? ""),
        mode: campaign.mode === "html" ? "html" : "design",
        design: parseEmailDesign(campaign.design),
        html: String(campaign.html ?? ""),
        senderAddress: String(campaign.senderAddress ?? ""),
      },
    });
  }
  return active;
}

export async function runCampaignSends(now = new Date()) {
  const summary = { campaigns: 0, batches: 0, finished: 0, paused: 0 };
  const hasWork = await Campaign.exists({ status: { $in: ["sending", "preparing"] } });
  if (!hasWork) return summary;

  await recoverInterrupted(now);
  let queue = await loadActive();
  summary.campaigns = queue.length;
  const outOfTime = cronDeadline();

  while (queue.length && !outOfTime()) {
    const next: Active[] = [];
    for (const active of queue) {
      if (outOfTime()) break;
      const outcome = await sendBatch(active, new Date());
      summary.batches += 1;
      if (outcome === "finished") summary.finished += 1;
      else if (outcome === "paused") summary.paused += 1;
      else if (outcome === "sent") next.push(active);
    }
    queue = next;
  }
  return summary;
}
