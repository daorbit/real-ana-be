import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { ReportSchedule, FREQUENCIES, computeNextRun, type Frequency } from "../../modules/reports/models/ReportSchedule.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { User } from "../../modules/identity/models/User.js";
import { canCreateReportSchedule, canConfigureReport } from "../../modules/billing/quota.service.js";
import { runSchedule, testTelegram, testWhatsApp } from "../../modules/reports/report-runner.js";
import { mailConfigured } from "../../infra/mail/mailer.js";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
import { planLimit } from "../plan-limit.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";

/**
 * Scheduled email reports, owned by the workspace owner.
 *
 * Mounted under `/api/workspaces/:wid/reports` so ownership is checked the same
 * way every other workspace-scoped route checks it: the workspace must belong
 * to the caller, or it doesn't exist as far as they're concerned.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;


/** The shape the client sees. `unsubToken` never leaves the server — it's a credential. */
function present(schedule: InstanceType<typeof ReportSchedule>) {
  return {
    id: schedule.id,
    name: schedule.get("name"),
    siteIds: schedule.get("siteIds"),
    frequency: schedule.get("frequency"),
    recipients: (schedule.get("recipients") as { email: string; unsubscribedAt?: Date }[]).map((r) => ({
      email: r.email,
      unsubscribed: Boolean(r.unsubscribedAt),
    })),
    channels: {
      email: schedule.get("channels")?.email ?? true,
      whatsapp: schedule.get("channels")?.whatsapp ?? false,
      telegram: schedule.get("channels")?.telegram ?? false,
    },
    telegramChatIds: schedule.get("telegramChatIds") ?? [],
    whatsappNumbers: schedule.get("whatsappNumbers") ?? [],
    include: schedule.get("include"),
    attachXlsx: schedule.get("attachXlsx"),
    enabled: schedule.get("enabled"),
    lastSentAt: schedule.get("lastSentAt"),
    nextRunAt: schedule.get("nextRunAt"),
    lastError: schedule.get("lastError"),
  };
}

/**
 * Validates and normalises a schedule body.
 *
 * The owner's own address is always included and always first: a report you
 * can't see going out is a report you can't tell is broken.
 */
async function readBody(req: AuthedRequest): Promise<
  | { ok: true; value: { name: string; siteIds: string[]; frequency: Frequency; emails: string[]; telegramChatIds: string[]; whatsappNumbers: string[]; channels: { email: boolean; whatsapp: boolean; telegram: boolean }; include: Record<string, boolean>; attachXlsx: boolean } }
  | { ok: false; error: string }
> {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) return { ok: false, error: "name is required" };

  const frequency = String(req.body?.frequency ?? "");
  if (!FREQUENCIES.includes(frequency as Frequency))
    return { ok: false, error: `frequency must be one of ${FREQUENCIES.join(", ")}` };

  const include = {
    analytics: req.body?.include?.analytics !== false,
    seo: req.body?.include?.seo !== false,
    dashboardLink: Boolean(req.body?.include?.dashboardLink),
    // Defaults on, so a client that has not been updated to know about the
    // field keeps getting the summary rather than silently losing it.
    aiSummary: req.body?.include?.aiSummary !== false,
  };
  if (!include.analytics && !include.seo)
    return { ok: false, error: "include analytics, SEO, or both — a report of neither is empty" };

  const owner = await User.findById(req.userId).select("email");
  const ownerEmail = String(owner?.get("email") ?? "").toLowerCase();

  const submitted = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  const extras = submitted
    .map((r: unknown) => String(typeof r === "string" ? r : (r as { email?: string })?.email ?? "").trim().toLowerCase())
    .filter(Boolean);

  for (const email of extras) {
    if (!EMAIL_RE.test(email)) return { ok: false, error: `"${email}" is not a valid email address` };
  }

  // Deduped with the owner first, so re-adding your own address can't produce
  // two copies of every report.
  const emails = [...new Set([ownerEmail, ...extras])].filter(Boolean);

  const siteIds = Array.isArray(req.body?.siteIds)
    ? req.body.siteIds.map((s: unknown) => String(s)).filter(Boolean).slice(0, 50)
    : [];

  const channels = {
    email: req.body?.channels?.email !== false,
    whatsapp: Boolean(req.body?.channels?.whatsapp),
    telegram: Boolean(req.body?.channels?.telegram),
  };
  if (!channels.email && !channels.whatsapp && !channels.telegram)
    return { ok: false, error: "pick at least one delivery channel" };

  const telegramChatIds: string[] = Array.isArray(req.body?.telegramChatIds)
    ? [...new Set<string>(req.body.telegramChatIds.map((c: unknown) => String(c).trim()).filter((c: string) => /^-?\d{1,20}$/.test(c)))].slice(0, 20)
    : [];
  if (channels.telegram && !telegramChatIds.length)
    return { ok: false, error: "pick at least one Telegram chat, or turn Telegram delivery off" };

  const whatsappNumbers: string[] = Array.isArray(req.body?.whatsappNumbers)
    ? [...new Set<string>(req.body.whatsappNumbers.map((n: unknown) => String(n).replace(/[^\d]/g, "")).filter((n: string) => /^\d{8,15}$/.test(n)))].slice(0, 10)
    : [];
  if (channels.whatsapp && !whatsappNumbers.length)
    return { ok: false, error: "pick at least one WhatsApp number, or turn WhatsApp delivery off" };

  return {
    ok: true,
    value: {
      name,
      siteIds,
      frequency: frequency as Frequency,
      emails,
      telegramChatIds: channels.telegram ? telegramChatIds : [],
      whatsappNumbers: channels.whatsapp ? whatsappNumbers : [],
      channels,
      include,
      attachXlsx: req.body?.attachXlsx !== false,
    },
  };
}

function recipientCount(value: { emails: string[]; telegramChatIds: string[]; whatsappNumbers: string[] }): number {
  return value.emails.length + value.telegramChatIds.length + value.whatsappNumbers.length;
}

router.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const schedules = await ReportSchedule.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  res.json({ schedules: schedules.map(present), mailConfigured: mailConfigured() });
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const parsed = await readBody(req);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const allowed = await canCreateReportSchedule(ws.id);
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

  const configurable = await canConfigureReport(ws.id, parsed.value.frequency, recipientCount(parsed.value), parsed.value.channels.whatsapp);
  if (!configurable.ok) return planLimit(res, configurable.error, configurable.limit);

  const schedule = await ReportSchedule.create({
    workspaceId: ws.id,
    name: parsed.value.name,
    siteIds: parsed.value.siteIds,
    frequency: parsed.value.frequency,
    recipients: parsed.value.emails.map((email) => ({ email, unsubToken: nanoid(32) })),
    telegramChatIds: parsed.value.telegramChatIds,
    whatsappNumbers: parsed.value.whatsappNumbers,
    channels: parsed.value.channels,
    include: parsed.value.include,
    attachXlsx: parsed.value.attachXlsx,
    nextRunAt: computeNextRun(parsed.value.frequency),
  });

  res.status(201).json(present(schedule));
});

router.put("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });

  const parsed = await readBody(req);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const configurable = await canConfigureReport(ws.id, parsed.value.frequency, recipientCount(parsed.value), parsed.value.channels.whatsapp);
  if (!configurable.ok) return planLimit(res, configurable.error, configurable.limit);

  // Existing recipients keep their unsubscribe token, and their unsubscribed
  // state with it. Reissuing tokens on every edit would silently resubscribe
  // everyone who had opted out, and break the link in mail already delivered.
  const existing = new Map(
    (schedule.get("recipients") as { email: string; unsubToken: string; unsubscribedAt?: Date }[]).map((r) => [r.email, r])
  );

  schedule.set({
    name: parsed.value.name,
    siteIds: parsed.value.siteIds,
    frequency: parsed.value.frequency,
    channels: parsed.value.channels,
    telegramChatIds: parsed.value.telegramChatIds,
    whatsappNumbers: parsed.value.whatsappNumbers,
    include: parsed.value.include,
    attachXlsx: parsed.value.attachXlsx,
    recipients: parsed.value.emails.map(
      (email) => existing.get(email) ?? { email, unsubToken: nanoid(32) }
    ),
  });

  if (typeof req.body?.enabled === "boolean") schedule.set("enabled", req.body.enabled);
  // Frequency changes move the next run, otherwise a schedule switched from
  // monthly to daily would still wait until the 1st.
  schedule.set("nextRunAt", computeNextRun(parsed.value.frequency));

  await schedule.save();
  res.json(present(schedule));
});

router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });

  await schedule.deleteOne();
  res.status(204).end();
});

/**
 * Send this schedule now, to the owner only.
 *
 * Owner-only on purpose: "preview" must not be a way to mail a client an
 * unlimited number of times, and the person clicking is the person who should
 * see the result.
 */
router.post("/:id/test", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  if (!mailConfigured()) return res.status(503).json({ error: "outbound email is not configured" });

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });

  const owner = await User.findById(req.userId).select("email");
  const ownerEmail = String(owner?.get("email") ?? "").toLowerCase();

  try {
    const outcome = await runSchedule(schedule, { isTest: true, onlyTo: ownerEmail });
    if (!outcome.sent.length) {
      const reason = outcome.failed[0]?.error ?? "your address is not on this report's recipient list";
      return res.status(502).json({ error: `could not send: ${reason}` });
    }
    res.json({ ok: true, sentTo: outcome.sent });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post("/:id/test-whatsapp", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });
  if (!(schedule.get("channels")?.whatsapp)) return res.status(400).json({ error: "WhatsApp delivery is off for this report" });

  try {
    const result = await testWhatsApp(schedule);
    if (!result.whatsappSent.length) {
      return res.status(502).json({ error: result.whatsappFailed[0]?.error ?? "could not send to WhatsApp" });
    }
    res.json({ ok: true, sentTo: result.whatsappSent, failed: result.whatsappFailed });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

router.post("/:id/test-telegram", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });
  if (!(schedule.get("channels")?.telegram)) return res.status(400).json({ error: "Telegram delivery is off for this report" });

  try {
    const result = await testTelegram(schedule);
    if (!result.telegramSent.length) {
      return res.status(502).json({ error: result.telegramFailed[0]?.error ?? "could not send to Telegram" });
    }
    res.json({ ok: true, sentTo: result.telegramSent, failed: result.telegramFailed });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
