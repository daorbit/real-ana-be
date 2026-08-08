import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { ReportSchedule, FREQUENCIES, computeNextRun, type Frequency } from "../../modules/reports/models/ReportSchedule.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { User } from "../../modules/identity/models/User.js";
import { canCreateReportSchedule, canConfigureReport, canUseWhatsAppReports } from "../../modules/billing/quota.service.js";
import { runSchedule, testWhatsApp } from "../../modules/reports/report-runner.js";
import { normalizePhone, whatsappConfigured, sessionStatus } from "../../infra/messaging/whatsapp.js";
import { mailConfigured } from "../../infra/mail/mailer.js";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
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
    phoneRecipients: (schedule.get("phoneRecipients") as { phone: string; label?: string; optedOutAt?: Date }[]).map((p) => ({
      phone: p.phone,
      label: p.label ?? "",
      optedOut: Boolean(p.optedOutAt),
    })),
    channels: schedule.get("channels") ?? { email: true, whatsapp: false },
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
  | { ok: true; value: { name: string; siteIds: string[]; frequency: Frequency; emails: string[]; phones: { phone: string; label: string }[]; channels: { email: boolean; whatsapp: boolean }; include: Record<string, boolean>; attachXlsx: boolean } }
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

  const owner = await User.findById(req.userId).select("email mobile");
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

  // Channels default to email-only, matching how every schedule behaved before
  // WhatsApp existed.
  const channels = {
    email: req.body?.channels?.email !== false,
    whatsapp: Boolean(req.body?.channels?.whatsapp),
  };
  if (!channels.email && !channels.whatsapp)
    return { ok: false, error: "pick at least one delivery channel" };

  /**
   * WhatsApp goes to the account owner's own mobile, and nowhere else.
   *
   * The platform sends from one paired number shared by every account, so a
   * report delivered to a customer's client would arrive from a stranger's
   * personal WhatsApp — and any complaint about it would land on the one
   * account that can be banned. Restricting the channel to the owner's own
   * verified mobile keeps it useful (you get your numbers on your phone)
   * without turning a shared sender into a way to message third parties.
   *
   * Client-facing delivery stays on email, which has a real unsubscribe.
   */
  const phones: { phone: string; label: string }[] = [];
  if (channels.whatsapp) {
    const ownerMobile = normalizePhone(String(owner?.get("mobile") ?? ""));
    if (!ownerMobile)
      return {
        ok: false,
        error: "add your mobile number in Settings before turning on WhatsApp delivery",
      };
    phones.push({ phone: ownerMobile, label: "You" });
  }

  return {
    ok: true,
    value: { name, siteIds, frequency: frequency as Frequency, emails, phones, channels, include, attachXlsx: req.body?.attachXlsx !== false },
  };
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
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const configurable = await canConfigureReport(ws.id, parsed.value.frequency, parsed.value.emails.length, parsed.value.channels.whatsapp);
  if (!configurable.ok) return res.status(402).json({ error: configurable.error, code: "quota_exceeded" });

  const schedule = await ReportSchedule.create({
    workspaceId: ws.id,
    name: parsed.value.name,
    siteIds: parsed.value.siteIds,
    frequency: parsed.value.frequency,
    recipients: parsed.value.emails.map((email) => ({ email, unsubToken: nanoid(32) })),
    phoneRecipients: parsed.value.phones,
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

  const configurable = await canConfigureReport(ws.id, parsed.value.frequency, parsed.value.emails.length, parsed.value.channels.whatsapp);
  if (!configurable.ok) return res.status(402).json({ error: configurable.error, code: "quota_exceeded" });

  // Existing recipients keep their unsubscribe token, and their unsubscribed
  // state with it. Reissuing tokens on every edit would silently resubscribe
  // everyone who had opted out, and break the link in mail already delivered.
  const existing = new Map(
    (schedule.get("recipients") as { email: string; unsubToken: string; unsubscribedAt?: Date }[]).map((r) => [r.email, r])
  );

  // Phone numbers keep their opted-out state across an edit, same reasoning as
  // the email unsubscribe tokens above.
  const existingPhones = new Map(
    (schedule.get("phoneRecipients") as { phone: string; label?: string; optedOutAt?: Date }[]).map((p) => [p.phone, p])
  );

  schedule.set({
    name: parsed.value.name,
    siteIds: parsed.value.siteIds,
    frequency: parsed.value.frequency,
    channels: parsed.value.channels,
    phoneRecipients: parsed.value.phones.map((p) => {
      const prior = existingPhones.get(p.phone);
      return prior ? { ...p, optedOutAt: prior.optedOutAt } : p;
    }),
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

/**
 * Whether WhatsApp delivery is available, and the paired session's state.
 *
 * The session is checked live rather than cached: an unofficial gateway drops
 * its pairing without warning, and a UI that says "connected" from a lookup an
 * hour old is worse than one that says nothing.
 */
router.get("/whatsapp/status", async (_req: AuthedRequest, res: Response) => {
  if (!whatsappConfigured()) return res.json({ configured: false });

  try {
    const session = await sessionStatus();
    // The paired number is deliberately not returned: it belongs to the
    // platform, not the account, and no client screen has a use for it.
    res.json({ configured: true, status: session.status });
  } catch (e) {
    // A gateway that is down is a status, not a server error — the page still
    // renders, it just reports the channel as unavailable.
    res.json({ configured: true, status: "error", error: (e as Error).message });
  }
});

/**
 * Send this report over WhatsApp now, to one number the owner nominates.
 *
 * The number must already be on the schedule: "test" must not become a way to
 * message an arbitrary phone through someone else's paired account.
 */
router.post("/:id/test-whatsapp", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  if (!whatsappConfigured()) return res.status(503).json({ error: "WhatsApp is not configured" });

  // Checked here as well as on save: a schedule created on Pro keeps its
  // WhatsApp channel after a downgrade, and without this the test button
  // stays a working way to send messages the plan no longer includes.
  const allowed = await canUseWhatsAppReports(ws.id);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error });

  const schedule = await ReportSchedule.findOne({ _id: req.params.id, workspaceId: ws.id });
  if (!schedule) return res.status(404).json({ error: "schedule not found" });

  const requested = normalizePhone(String(req.body?.phone ?? ""));
  const onSchedule = (schedule.get("phoneRecipients") as { phone: string }[]).some(
    (p) => p.phone === requested
  );
  if (!requested || !onSchedule)
    return res.status(400).json({ error: "pick a number that is already on this report" });

  try {
    const messageId = await testWhatsApp(schedule, requested);
    res.json({ ok: true, sentTo: requested, messageId });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
