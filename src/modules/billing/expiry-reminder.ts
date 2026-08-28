import { Subscription } from "./models/Subscription.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { User } from "../identity/models/User.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import { sendPlanExpiryEmail } from "../../infra/mail/mailer.js";
const REMIND_DAYS = [7, 1];
function alreadySent(sent: unknown, mark: number): boolean {
  return Array.isArray(sent) && sent.includes(mark);
}

export interface ExpirySummary {
  checked: number;
  sent: number;
  failed: number;
  errors: string[];
}

export async function sendExpiryReminders(): Promise<ExpirySummary> {
  const summary: ExpirySummary = { checked: 0, sent: 0, failed: 0, errors: [] };
  const now = Date.now();
  const horizon = new Date(now + Math.max(...REMIND_DAYS) * 24 * 60 * 60 * 1000);
  const subs = await Subscription.find({
    planSlug: { $ne: "free" },
    currentPeriodEnd: { $gt: new Date(now), $lte: horizon },
  });

  for (const sub of subs) {
    summary.checked += 1;

    const end = sub.get("currentPeriodEnd") as Date | null;
    if (!end) continue;

    const daysLeft = Math.ceil((end.getTime() - now) / (24 * 60 * 60 * 1000));
    const mark = REMIND_DAYS.find((d) => daysLeft <= d);
    if (mark === undefined) continue;
    if (alreadySent(sub.get("expiryRemindersSent"), mark)) continue;

    try {
      const [workspace, user] = await Promise.all([
        Workspace.findById(sub.get("workspaceId")).select("name"),
        User.findById(sub.get("userId")).select("email name"),
      ]);
      if (!user?.get("email")) continue;

      const plan = getPlanCatalogEntry(sub.get("planSlug") as string);

      await sendPlanExpiryEmail(
        { email: user.get("email") as string, name: user.get("name") as string },
        {
          workspaceName: (workspace?.get("name") as string) ?? "your workspace",
          planName: plan?.name ?? (sub.get("planSlug") as string),
          daysLeft,
          endsOn: end,
        },
      );
      await Subscription.updateOne(
        { _id: sub.get("_id") },
        { $addToSet: { expiryRemindersSent: mark } },
      );
      summary.sent += 1;
    } catch (e) {
      summary.failed += 1;
      summary.errors.push(`${sub.get("workspaceId")}: ${(e as Error).message}`);
    }
  }

  return summary;
}
