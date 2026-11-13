import type { Types } from "mongoose";
import { mailConfigured, sendOne } from "../../infra/mail/mailer.js";
import { cronDeadline } from "../../shared/utils/time-budget.js";
import { StatusEmailJob } from "./models/StatusEmailJob.js";
import { StatusIncident } from "./models/StatusIncident.js";
import { StatusSubscriber } from "./models/StatusSubscriber.js";
import { updateEmail } from "./emails.js";
import type { IncidentRow } from "./present.js";

const BATCH = 40;
const CLAIM_MS = 3 * 60 * 1000;
const BUDGET_MS = 35_000;

type JobRow = { _id: Types.ObjectId; incidentId: Types.ObjectId; updateId: Types.ObjectId; cursor: Types.ObjectId | null };
type SubscriberRow = { _id: Types.ObjectId; email: string; token: string };

async function claimJob(now: Date): Promise<JobRow | null> {
  return StatusEmailJob.findOneAndUpdate(
    { done: false, $or: [{ claimedUntil: null }, { claimedUntil: { $lt: now } }] },
    { $set: { claimedUntil: new Date(now.getTime() + CLAIM_MS) } },
    { sort: { createdAt: 1 }, new: true },
  ).lean<JobRow>();
}

async function runJob(job: JobRow, outOfTime: () => boolean): Promise<number> {
  const incident = await StatusIncident.findById(job.incidentId).select("title updates").lean<Pick<IncidentRow, "_id" | "title" | "updates">>();
  const update = incident?.updates.find((u) => String(u._id) === String(job.updateId));
  if (!incident || !update) {
    await StatusEmailJob.updateOne({ _id: job._id }, { $set: { done: true } });
    return 0;
  }

  const subscribers = await StatusSubscriber.find({ confirmedAt: { $ne: null }, ...(job.cursor ? { _id: { $gt: job.cursor } } : {}) })
    .sort({ _id: 1 })
    .limit(BATCH)
    .select("email token")
    .lean<SubscriberRow[]>();

  let sent = 0;
  let failed = 0;
  let processed = 0;
  let cursor = job.cursor;
  for (const subscriber of subscribers) {
    if (outOfTime()) break;
    const message = updateEmail({ id: String(incident._id), title: incident.title }, update, subscriber.token);
    try {
      await sendOne({ email: subscriber.email }, message.subject, message.text, message.html, [], message.headers);
      sent += 1;
    } catch {
      failed += 1;
    }
    processed += 1;
    cursor = subscriber._id;
  }

  const finished = processed === subscribers.length && subscribers.length < BATCH;
  await StatusEmailJob.updateOne(
    { _id: job._id },
    { $set: { cursor, done: finished, claimedUntil: null }, $inc: { sent, failed } },
  );
  return sent;
}

export async function runStatusEmails(): Promise<{ sent: number }> {
  if (!(await StatusSubscriber.exists({ confirmedAt: { $ne: null } }))) {
    await StatusEmailJob.updateMany({ done: false }, { $set: { done: true } });
    return { sent: 0 };
  }
  if (!mailConfigured()) return { sent: 0 };
  const outOfTime = cronDeadline(BUDGET_MS);
  let sent = 0;
  while (!outOfTime()) {
    const job = await claimJob(new Date());
    if (!job) break;
    sent += await runJob(job, outOfTime);
  }
  return { sent };
}
