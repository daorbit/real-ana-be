import { currentPlan } from "../billing/quota.service.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { Campaign } from "./models/Campaign.js";
import { CampaignRecipient } from "./models/CampaignRecipient.js";
import type { CampaignContact } from "./campaign-draft.js";
import { leadContacts } from "./campaign-delivery.js";
import { suppressedAmong } from "./suppression.service.js";

const LIST_LIMIT = 100;
const INSERT_CHUNK = 1_000;

export function presentCampaign(doc: InstanceType<typeof Campaign>, withContacts = false) {
  const imported = (doc.get("imported") ?? []) as CampaignContact[];
  return {
    id: String(doc._id),
    name: doc.get("name") as string,
    subject: doc.get("subject") as string,
    body: doc.get("body") as string,
    ctaLabel: doc.get("ctaLabel") as string,
    ctaUrl: doc.get("ctaUrl") as string,
    senderAddress: doc.get("senderAddress") as string,
    formIds: doc.get("formIds") as string[],
    importedCount: imported.length,
    ...(withContacts ? { imported: imported.map((c) => ({ email: c.email, name: c.name })) } : {}),
    status: doc.get("status") as string,
    counts: doc.get("counts") as { total: number; sent: number; failed: number; unsubscribed: number },
    lastError: doc.get("lastError") as string,
    startedAt: doc.get("startedAt") as Date | null,
    finishedAt: doc.get("finishedAt") as Date | null,
    createdAt: doc.get("createdAt") as Date,
    updatedAt: doc.get("updatedAt") as Date,
  };
}

function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function campaignUsage(workspaceId: string) {
  const [plan, used] = await Promise.all([
    currentPlan(workspaceId),
    CampaignRecipient.countDocuments({
      workspaceId,
      createdAt: { $gte: startOfMonth() },
      status: { $ne: "skipped" },
    }),
  ]);
  const entry = plan ?? getPlanCatalogEntry("free")!;
  return { used, limit: entry.monthlyCampaignEmails, plan: entry.name };
}

export async function listCampaigns(workspaceId: string) {
  const [docs, usage] = await Promise.all([
    Campaign.find({ workspaceId }).select("-imported").sort({ createdAt: -1 }).limit(LIST_LIMIT),
    campaignUsage(workspaceId),
  ]);
  return { campaigns: docs.map((doc) => presentCampaign(doc)), usage };
}

export async function campaignAudience(workspaceId: string, formIds: string[], imported: CampaignContact[]) {
  const fromForms = await leadContacts(workspaceId, formIds);
  const unique = new Map<string, { email: string; name: string }>();
  for (const contact of [...fromForms, ...imported]) {
    if (!unique.has(contact.email)) unique.set(contact.email, { email: contact.email, name: contact.name ?? "" });
  }
  const everyone = [...unique.values()];
  const blocked = await suppressedAmong(workspaceId, everyone.map((c) => c.email));
  return { contacts: everyone.filter((c) => !blocked.has(c.email)), suppressed: blocked.size };
}

export async function prepareRecipients(
  workspaceId: string,
  campaignId: unknown,
  contacts: { email: string; name: string }[],
): Promise<void> {
  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    const rows = contacts.slice(i, i + INSERT_CHUNK).map((contact) => ({ campaignId, workspaceId, ...contact }));
    await CampaignRecipient.insertMany(rows, { ordered: false });
  }
}

export async function deleteCampaign(campaignId: unknown): Promise<void> {
  await Promise.all([CampaignRecipient.deleteMany({ campaignId }), Campaign.deleteOne({ _id: campaignId })]);
}
