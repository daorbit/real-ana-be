import { Campaign } from "./models/Campaign.js";
import { CampaignRecipient } from "./models/CampaignRecipient.js";
import { EmailSuppression, type SuppressionReason } from "./models/EmailSuppression.js";

export async function suppressEmails(workspaceId: string, emails: string[], reason: SuppressionReason): Promise<number> {
  const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return 0;

  const [written] = await Promise.all([
    EmailSuppression.bulkWrite(
      unique.map((email) => ({
        updateOne: {
          filter: { workspaceId, email },
          update: { $setOnInsert: { workspaceId, email, reason } },
          upsert: true,
        },
      })),
      { ordered: false },
    ),
    CampaignRecipient.updateMany({ workspaceId, email: { $in: unique }, status: "pending" }, { $set: { status: "skipped" } }),
  ]);
  return written.upsertedCount;
}

export async function unsubscribe(workspaceId: string, campaignId: string, email: string): Promise<void> {
  const added = await suppressEmails(workspaceId, [email], "unsubscribed");
  if (added) await Campaign.updateOne({ _id: campaignId, workspaceId }, { $inc: { "counts.unsubscribed": 1 } });
}

export async function suppressedAmong(workspaceId: string, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = await EmailSuppression.find({ workspaceId, email: { $in: emails } }).select("email").lean();
  return new Set(rows.map((row) => String(row.email)));
}
