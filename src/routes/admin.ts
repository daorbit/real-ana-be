import { Router, Response } from "express";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { ApiKey } from "../models/ApiKey.js";
import { Goal } from "../models/Goal.js";
import { Project } from "../models/Project.js";
import { getDemoDailyLimit, setDemoDailyLimit } from "../models/AppSetting.js";
import { Plan } from "../models/Plan.js";
import { Subscription } from "../models/Subscription.js";
import { AddonPack } from "../models/AddonPack.js";
import { Coupon } from "../models/Coupon.js";
import { demoUsageSnapshot } from "../lib/demo-limit.js";
import { listResolvedPlans, getResolvedPlan } from "../lib/planPricing.js";
import { quotaSummary } from "../lib/quota.js";
import { getPlanCatalogEntry } from "../plans.js";
import { CURRENCIES } from "../lib/currency.js";
import { mailConfigured, mailFrom, sendBulk, broadcastHtml, inviteHtml, personalize, forBrowser } from "../lib/mail.js";
import { MAIL_TEMPLATES } from "../lib/mail-templates.js";
import { requireAuth, requireAdmin, signImpersonationToken, AuthedRequest } from "../auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const PAGE_SIZE = 20;

/**
 * Every account, for the admin's user switcher.
 *
 * `q` matches email or name, `role` narrows to admins or plain users, and the
 * result is paged. The match is a case-insensitive regex rather than a text
 * index — the list is small, and a partial "goswa" needs to hit mid-word.
 */
router.get("/users", async (req: AuthedRequest, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const role = String(req.query.role ?? "").trim();
  const page = Math.max(1, Number(req.query.page) || 1);

  const filter: Record<string, unknown> = {};
  if (q) {
    filter.$or = [
      { email: { $regex: escapeRegex(q), $options: "i" } },
      { name: { $regex: escapeRegex(q), $options: "i" } },
    ];
  }
  if (role === "admin" || role === "user") filter.role = role;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("email name role createdAt")
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE),
    User.countDocuments(filter),
  ]);

  // One grouped query per collection for the whole page beats a query per user.
  const ids = users.map((u) => u._id);
  const workspaces = await Workspace.find({ userId: { $in: ids } }).select("userId");
  const ownerByWorkspace = new Map(
    workspaces.map((w) => [String(w._id), String(w.userId)]),
  );

  const wsByUser = new Map<string, number>();
  for (const owner of ownerByWorkspace.values())
    wsByUser.set(owner, (wsByUser.get(owner) ?? 0) + 1);

  // Sites resolve through the workspace, not `Site.userId` — platform-created
  // sites have no dashboard user, so keying off the workspace is what makes
  // their traffic show up under the account that actually owns them.
  const pageSites = await Site.find({
    workspaceId: { $in: [...ownerByWorkspace.keys()] },
  }).select("siteId workspaceId");

  const sitesByUser = new Map<string, number>();
  const ownerBySiteId = new Map<string, string>();
  for (const s of pageSites) {
    const owner = ownerByWorkspace.get(String(s.workspaceId));
    if (!owner) continue;
    ownerBySiteId.set(String(s.siteId), owner);
    sitesByUser.set(owner, (sitesByUser.get(owner) ?? 0) + 1);
  }

  // Events key off `siteId` (the public nanoid), not the owner, so the sites
  // above are the bridge back to a user.
  const eventCounts = await Event.aggregate<{ _id: string; n: number; last: Date }>([
    { $match: { siteId: { $in: [...ownerBySiteId.keys()] } } },
    { $group: { _id: "$siteId", n: { $sum: 1 }, last: { $max: "$ts" } } },
  ]);
  const eventsByUser = new Map<string, { n: number; last: Date | null }>();
  for (const row of eventCounts) {
    const owner = ownerBySiteId.get(row._id);
    if (!owner) continue;
    const acc = eventsByUser.get(owner) ?? { n: 0, last: null };
    acc.n += row.n;
    if (row.last && (!acc.last || row.last > acc.last)) acc.last = row.last;
    eventsByUser.set(owner, acc);
  }

  const subs = await Subscription.find({ userId: { $in: ids } }).select("userId planSlug status currentPeriodEnd");
  const subByUser = new Map(subs.map((s) => [String(s.userId), s]));

  res.json({
    users: users.map((u) => {
      const sub = subByUser.get(u.id);
      const expired = sub ? new Date(sub.currentPeriodEnd as Date).getTime() < Date.now() : true;
      const planEntry = sub ? getPlanCatalogEntry(sub.planSlug as string) : null;
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        createdAt: u.get("createdAt"),
        workspaceCount: wsByUser.get(u.id) ?? 0,
        siteCount: sitesByUser.get(u.id) ?? 0,
        eventCount: eventsByUser.get(u.id)?.n ?? 0,
        lastEventAt: eventsByUser.get(u.id)?.last ?? null,
        plan: planEntry ? { slug: planEntry.slug, name: planEntry.name, expired } : null,
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

/** A user's plan, cycle, and quota usage — same shape the dashboard shows the user themselves. */
router.get("/users/:userId/billing", async (req: AuthedRequest, res: Response) => {
  const target = await User.findById(req.params.userId).select("_id");
  if (!target) return res.status(404).json({ error: "user not found" });

  const summary = await quotaSummary(String(req.params.userId));
  if (!summary) return res.json({ subscribed: false });
  res.json({ subscribed: true, ...summary });
});

/**
 * Mint a token that acts as the target user.
 *
 * The token carries the admin's id as `impersonatorId`, so the act stays
 * attributable, and every existing route keeps its normal `userId` guard —
 * nothing is relaxed for admins, which is what keeps one bad id parameter from
 * turning into a cross-tenant leak.
 */
router.post("/impersonate/:userId", async (req: AuthedRequest, res: Response) => {
  const target = await User.findById(req.params.userId).select("email name role");
  if (!target) return res.status(404).json({ error: "user not found" });

  // Admins impersonating admins is an escalation path with no legitimate use.
  if (target.role === "admin")
    return res.status(400).json({ error: "cannot impersonate an admin" });

  const token = signImpersonationToken(target.id, req.userId as string);

  console.log(`[impersonate] admin ${req.userId} -> user ${target.id} (${target.email})`);

  res.json({
    token,
    user: { id: target.id, email: target.email, name: target.name, role: target.role },
  });
});

/**
 * Delete an account and everything it owns.
 *
 * The cascade mirrors workspace deletion, one tenant at a time: a user's
 * workspaces take their sites, and each site takes its events. Api keys hang
 * off the user directly, so they go in one sweep. The user row is last, so a
 * mid-cascade failure leaves the account still present and retryable rather
 * than an orphaned pile of data pointing at nothing.
 */
router.delete("/users/:userId", async (req: AuthedRequest, res: Response) => {
  const target = await User.findById(req.params.userId).select("email role");
  if (!target) return res.status(404).json({ error: "user not found" });

  // Deleting an admin — or yourself — is an own-goal with no undo, so block
  // both at the door. The role guard also stops one admin from wiping another.
  if (target.role === "admin")
    return res.status(400).json({ error: "cannot delete an admin account" });
  if (target.id === req.userId)
    return res.status(400).json({ error: "cannot delete your own account" });

  const workspaces = await Workspace.find({ userId: target.id }).select("_id");
  const wsIds = workspaces.map((w) => w._id);

  const sites = await Site.find({ workspaceId: { $in: wsIds } }).select("siteId");
  const siteIds = sites.map((s) => s.siteId);

  await Event.deleteMany({ siteId: { $in: siteIds } });
  await Site.deleteMany({ workspaceId: { $in: wsIds } });
  // Keys are scoped to the workspace as well as the user — platform keys
  // created under a workspace would otherwise survive the account.
  await ApiKey.deleteMany({
    $or: [{ userId: target.id }, { workspaceId: { $in: wsIds } }],
  });
  await Goal.deleteMany({ workspaceId: { $in: wsIds } });
  await Project.deleteMany({ workspaceId: { $in: wsIds } });
  await Workspace.deleteMany({ userId: target.id });
  await target.deleteOne();

  console.log(`[admin] ${req.userId} deleted user ${target.id} (${target.email})`);

  res.json({ ok: true });
});

/** Characters that would otherwise be read as regex syntax in a search box. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------- demo usage ------------------------------- */

/**
 * How the public demo is being used.
 *
 * The figures come from the in-process throttle rather than a table: nothing
 * about a demo visitor is stored, so this is a live snapshot — counts reset
 * when the server does, and each instance reports its own. Enough to see
 * whether the demo is being used and whether the limit is biting; deliberately
 * not an audit trail.
 */
router.get("/demo/usage", async (_req: AuthedRequest, res: Response) => {
  const [limit, snapshot] = await Promise.all([
    getDemoDailyLimit(),
    Promise.resolve(demoUsageSnapshot()),
  ]);
  res.json({ limit, ...snapshot });
});

/** Change how many demo sessions one address may start per day. */
router.put("/demo/limit", async (req: AuthedRequest, res: Response) => {
  const requested = Number(req.body?.limit);
  if (!Number.isFinite(requested) || requested < 1) {
    return res.status(400).json({ error: "limit must be a positive number" });
  }
  const limit = await setDemoDailyLimit(requested);
  res.json({ limit });
});

/* --------------------------------- email ---------------------------------- */

/** Hard ceiling on one send, well under Gmail's daily cap for a free account. */
const MAX_RECIPIENTS = 200;

/**
 * Whether email can be sent at all, and from where.
 *
 * The composer asks before it opens so it can explain a missing app password
 * up front, rather than letting an admin write a message and only then
 * discover it can't go anywhere.
 */
router.get("/email/status", async (_req: AuthedRequest, res: Response) => {
  res.json({ configured: mailConfigured(), from: mailFrom() });
});

/** The canned messages, served from one place so wording can't drift. */
router.get("/email/templates", async (_req: AuthedRequest, res: Response) => {
  res.json({ templates: MAIL_TEMPLATES });
});

/**
 * Render a draft exactly as it will arrive.
 *
 * The same `broadcastHtml` and `personalize` the send path uses, so the preview
 * cannot drift from the real thing — an admin writing `{{name}}` sees a name,
 * not a placeholder, which is the difference between proofreading a message and
 * guessing at one.
 */
router.post("/email/preview", async (req: AuthedRequest, res: Response) => {
  const subject = String(req.body?.subject ?? "");
  const body = String(req.body?.body ?? "");

  // Preview against a real recipient when one is named, so the personalisation
  // is checked against the name that will actually be substituted.
  //
  // `anonymous` previews the other case: a bare address with no name, which is
  // what most invitations go to. Without it an admin would only ever see the
  // flattering version and never notice that their opening line reads badly
  // when there is no name to drop into it.
  let sample: { email: string; name: string } =
    req.body?.anonymous === true
      ? { email: "someone@example.com", name: "" }
      : { email: "someone@example.com", name: "Alex Morgan" };

  const userId = req.body?.userId;
  if (typeof userId === "string" && userId) {
    const target = await User.findById(userId).select("email name");
    if (target) sample = { email: target.email, name: target.name };
  }

  const cta = readCta(req.body?.cta);
  const text = personalize(body, sample);
  const html =
    readLayout(req.body?.layout) === "invite" && cta
      ? inviteHtml(text, cta)
      : broadcastHtml(text, cta);

  res.json({
    subject: personalize(subject, sample),
    html: forBrowser(html),
    // Empty when previewing the no-name case; the composer says "someone with no
    // name on file" rather than leaving a gap in its caption.
    sampleName: sample.name,
  });
});

/** Only the layouts the renderer knows. Anything else falls back to plain text. */
function readLayout(raw: unknown): "plain" | "invite" {
  return raw === "invite" ? "invite" : "plain";
}

/**
 * Parse hand-entered recipients.
 *
 * Accepts either a bare address or `Name <address>`, so an admin can paste from
 * a contact list and still get `{{name}}` filled in. A bare address gets no name
 * at all rather than one invented from the local part: templates use
 * `{{greeting}}`, which reads as a plain "Hello" when nothing is known, instead
 * of greeting a stranger as "alex".
 *
 * Deliberately strict about the address and permissive about everything else:
 * an unparseable address is a bounce and a small hit to sender reputation, which
 * is worth one clear error before the send rather than a silent failure after.
 */
function parseAddresses(raw: unknown[]): {
  valid: { email: string; name: string }[];
  invalid: string[];
} {
  const valid: { email: string; name: string }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const text = String(entry ?? "").trim();
    if (!text) continue;

    const angled = /^(.*?)<([^>]+)>$/.exec(text);
    const name = angled ? angled[1].trim().replace(/^["']|["']$/g, "") : "";
    const email = (angled ? angled[2] : text).trim().toLowerCase();

    // Same deliberately-permissive shape the signup path uses: the only real
    // authority on an address is a delivered message.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      invalid.push(text.slice(0, 80));
      continue;
    }

    // Sending the same person two copies of an invitation is worse than sending
    // none, so duplicates are collapsed rather than rejected.
    if (seen.has(email)) continue;
    seen.add(email);

    valid.push({ email, name });
  }

  return { valid, invalid };
}

/** A caller-supplied button, accepted only when both halves are usable. */
function readCta(raw: unknown): { label: string; href: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { label, href } = raw as { label?: unknown; href?: unknown };
  const l = String(label ?? "").trim().slice(0, 40);
  const h = String(href ?? "").trim();
  // The renderer refuses non-http(s) too; rejecting here keeps a bad value from
  // silently becoming a message with no button and no explanation.
  if (!l || !/^https?:\/\//i.test(h)) return undefined;
  return { label: l, href: h };
}

/**
 * The audiences an admin can send to, with a count for each.
 *
 * "Not installed" is the one that motivated this: an account that signed up,
 * has a site, and has never sent an event is someone who stopped at the
 * snippet. Installation isn't a stored flag anywhere — it's inferred from
 * whether any event has ever arrived for the account's sites — so the segments
 * are computed here rather than read off a column.
 */
router.get("/email/segments", async (_req: AuthedRequest, res: Response) => {
  const segments = await Promise.all(
    (["all", "not-installed", "no-sites", "installed"] as const).map(async (id) => ({
      id,
      label: SEGMENT_LABELS[id],
      description: SEGMENT_DESCRIPTIONS[id],
      count: (await resolveSegment(id)).length,
    })),
  );
  res.json({ segments });
});

/**
 * Who a segment resolves to, so the composer can show the actual list before
 * anything is sent. Sending to people is not undoable; seeing the names first
 * is what makes a wrong pick recoverable.
 */
router.get("/email/recipients", async (req: AuthedRequest, res: Response) => {
  const segment = String(req.query.segment ?? "all");
  if (!isSegment(segment)) return res.status(400).json({ error: "unknown segment" });
  res.json({ recipients: await resolveSegment(segment) });
});

/**
 * Send a message to a segment, or to a hand-picked set of user ids.
 *
 * Explicit `userIds` win over the segment: the composer lets an admin start
 * from a segment and then untick individuals, and the resulting list is what
 * gets sent — not the segment re-resolved server-side, which could have
 * shifted between preview and send.
 *
 * Sending is sequential and can take a while for a large list, so the response
 * is a per-recipient tally rather than a bare ok — a partial failure is normal
 * with SMTP and the admin needs to see which addresses bounced.
 */
router.post("/email/send", async (req: AuthedRequest, res: Response) => {
  if (!mailConfigured()) {
    return res.status(503).json({
      error: "email is not configured — set SMTP_USER and SMTP_PASS",
    });
  }

  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  if (!subject) return res.status(400).json({ error: "subject is required" });
  if (!body) return res.status(400).json({ error: "body is required" });

  const userIds: unknown = req.body?.userIds;
  const emails: unknown = req.body?.emails;
  let recipients: { id?: string; email: string; name: string }[];

  if (Array.isArray(emails) && emails.length) {
    // Hand-entered addresses, for inviting people who have no account. Parsed
    // and validated here because nothing in the database vouches for them.
    const parsed = parseAddresses(emails);
    if (parsed.invalid.length) {
      return res.status(400).json({
        error: `not a valid email address: ${parsed.invalid.slice(0, 5).join(", ")}`,
        invalid: parsed.invalid,
      });
    }
    recipients = parsed.valid;
  } else if (Array.isArray(userIds) && userIds.length) {
    const users = await User.find({ _id: { $in: userIds } }).select("email name");
    recipients = users.map((u) => ({ id: u.id, email: u.email, name: u.name }));
  } else {
    const segment = String(req.body?.segment ?? "");
    if (!isSegment(segment)) return res.status(400).json({ error: "unknown segment" });
    recipients = await resolveSegment(segment);
  }

  if (!recipients.length) {
    return res.status(400).json({ error: "no recipients matched" });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      error: `too many recipients (${recipients.length}) — the limit is ${MAX_RECIPIENTS} per send`,
    });
  }

  const results = await sendBulk(
    recipients,
    subject,
    body,
    readCta(req.body?.cta),
    readLayout(req.body?.layout),
  );
  const sent = results.filter((r) => r.ok).length;

  console.log(
    `[admin] ${req.userId} emailed ${sent}/${results.length} recipients — "${subject}"`,
  );

  res.json({
    sent,
    failed: results.length - sent,
    // Only failures carry detail worth returning; a list of successful
    // addresses is just the recipient list echoed back.
    failures: results.filter((r) => !r.ok),
  });
});

/**
 * Send one message to the admin themselves, ignoring segments.
 *
 * A template with a broken `{{name}}` or a wrong tone is much cheaper to catch
 * in your own inbox than in two hundred other people's.
 */
router.post("/email/test", async (req: AuthedRequest, res: Response) => {
  if (!mailConfigured()) {
    return res.status(503).json({
      error: "email is not configured — set SMTP_USER and SMTP_PASS",
    });
  }

  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  if (!subject || !body) {
    return res.status(400).json({ error: "subject and body are required" });
  }

  const me = await User.findById(req.userId).select("email name");
  if (!me) return res.status(404).json({ error: "user not found" });

  const [result] = await sendBulk(
    [{ email: me.email, name: me.name }],
    `[test] ${subject}`,
    body,
    readCta(req.body?.cta),
    readLayout(req.body?.layout),
  );

  if (!result.ok) return res.status(502).json({ error: result.error ?? "send failed" });
  res.json({ ok: true, email: me.email });
});

type SegmentId = "all" | "not-installed" | "no-sites" | "installed";

const SEGMENT_LABELS: Record<SegmentId, string> = {
  all: "Everyone",
  "not-installed": "Signed up, script not installed",
  "no-sites": "Signed up, no site added",
  installed: "Actively tracking",
};

const SEGMENT_DESCRIPTIONS: Record<SegmentId, string> = {
  all: "Every non-admin account.",
  "not-installed": "Has added a site but no event has ever arrived for it.",
  "no-sites": "Never got as far as adding a site.",
  installed: "At least one site is reporting events.",
};

function isSegment(v: string): v is SegmentId {
  return v === "all" || v === "not-installed" || v === "no-sites" || v === "installed";
}

/**
 * Turn a segment into the accounts it covers.
 *
 * Admins are excluded from every segment — these are customer messages, and an
 * admin receiving their own "you haven't installed the script yet" nudge is
 * noise. The site and event lookups mirror the user-list route: sites resolve
 * through the workspace, and events key off the public `siteId`.
 */
async function resolveSegment(
  segment: SegmentId,
): Promise<{ id: string; email: string; name: string }[]> {
  const users = await User.find({ role: { $ne: "admin" } }).select("email name");
  if (segment === "all") {
    return users.map((u) => ({ id: u.id, email: u.email, name: u.name }));
  }

  const workspaces = await Workspace.find({
    userId: { $in: users.map((u) => u._id) },
  }).select("userId");
  const ownerByWorkspace = new Map(
    workspaces.map((w) => [String(w._id), String(w.userId)]),
  );

  const sites = await Site.find({
    workspaceId: { $in: [...ownerByWorkspace.keys()] },
  }).select("siteId workspaceId");

  const ownerBySiteId = new Map<string, string>();
  const usersWithSites = new Set<string>();
  for (const s of sites) {
    const owner = ownerByWorkspace.get(String(s.workspaceId));
    if (!owner) continue;
    ownerBySiteId.set(String(s.siteId), owner);
    usersWithSites.add(owner);
  }

  // Only which sites have ever reported matters here, not how much — so this
  // asks for the distinct siteIds present in the events collection rather than
  // counting rows.
  const reporting = await Event.distinct("siteId", {
    siteId: { $in: [...ownerBySiteId.keys()] },
  });
  const usersWithEvents = new Set<string>();
  for (const siteId of reporting) {
    const owner = ownerBySiteId.get(String(siteId));
    if (owner) usersWithEvents.add(owner);
  }

  const matches = (id: string) => {
    if (segment === "no-sites") return !usersWithSites.has(id);
    if (segment === "not-installed") return usersWithSites.has(id) && !usersWithEvents.has(id);
    return usersWithEvents.has(id); // "installed"
  };

  return users
    .filter((u) => matches(u.id))
    .map((u) => ({ id: u.id, email: u.email, name: u.name }));
}

/* ------------------------------- billing plans ----------------------------- */

/**
 * The plan catalogue is fixed in code (`src/plans.ts`) — name, quotas,
 * workspace/site limits and Razorpay ids for each tier are not admin-editable.
 * The only thing an admin can change here is price, which is why there's no
 * create or delete route: adding or retiring a tier is a code change.
 */
router.get("/billing/plans", async (_req: AuthedRequest, res: Response) => {
  res.json(await listResolvedPlans());
});

/** Set a plan's per-currency prices. Upserts the price row — a catalogue plan with no row yet defaults to 0 in every currency. */
router.put("/billing/plans/:slug", async (req: AuthedRequest, res: Response) => {
  const slug = String(req.params.slug);
  if (!getPlanCatalogEntry(slug))
    return res.status(404).json({ error: "unknown plan" });

  const priceMonthly = readCurrencyPrices(req.body?.priceMonthly);
  const priceYearly = readCurrencyPrices(req.body?.priceYearly);
  if (!priceMonthly || !priceYearly) {
    return res.status(400).json({ error: "priceMonthly and priceYearly must have non-negative numbers for every currency" });
  }

  await Plan.updateOne(
    { slug },
    { $set: { priceMonthly, priceYearly } },
    { upsert: true }
  );
  res.json(await getResolvedPlan(slug));
});

/** Validates a `{ INR, USD, EUR }` price object from an admin request body. */
function readCurrencyPrices(body: unknown): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const currency of CURRENCIES) {
    const value = Number((body as Record<string, unknown> | undefined)?.[currency]);
    if (!Number.isFinite(value) || value < 0) return null;
    result[currency] = value;
  }
  return result;
}

/* ------------------------------- billing addons ----------------------------- */

router.get("/billing/addons", async (_req: AuthedRequest, res: Response) => {
  const addons = await AddonPack.find().sort({ sortOrder: 1 });
  res.json(addons);
});

router.post("/billing/addons", async (req: AuthedRequest, res: Response) => {
  try {
    const addon = await AddonPack.create(readAddonBody(req.body));
    res.status(201).json(addon);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.put("/billing/addons/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const addon = await AddonPack.findByIdAndUpdate(req.params.id, readAddonBody(req.body), {
      new: true,
      runValidators: true,
    });
    if (!addon) return res.status(404).json({ error: "addon not found" });
    res.json(addon);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.delete("/billing/addons/:id", async (req: AuthedRequest, res: Response) => {
  const deleted = await AddonPack.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "addon not found" });
  res.status(204).end();
});

function readAddonBody(body: Record<string, unknown>) {
  const type: "audit" | "crawl" = body?.type === "crawl" ? "crawl" : "audit";
  const price = Object.fromEntries(
    CURRENCIES.map((c) => [c, Math.max(0, Number((body?.price as Record<string, unknown>)?.[c]) || 0)])
  );
  return {
    name: String(body?.name ?? "").trim(),
    slug: String(body?.slug ?? "").trim().toLowerCase(),
    type,
    quantity: Math.max(1, Number(body?.quantity) || 1),
    price,
    active: body?.active !== false,
    sortOrder: Number(body?.sortOrder) || 0,
  };
}

/* --------------------------------- coupons ------------------------------------ */

router.get("/billing/coupons", async (_req: AuthedRequest, res: Response) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.json(coupons);
});

router.post("/billing/coupons", async (req: AuthedRequest, res: Response) => {
  try {
    const coupon = await Coupon.create(readCouponBody(req.body));
    res.status(201).json(coupon);
  } catch (e) {
    res.status(400).json({ error: couponErrorMessage(e) });
  }
});

router.put("/billing/coupons/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, readCouponBody(req.body), {
      new: true,
      runValidators: true,
    });
    if (!coupon) return res.status(404).json({ error: "coupon not found" });
    res.json(coupon);
  } catch (e) {
    res.status(400).json({ error: couponErrorMessage(e) });
  }
});

router.delete("/billing/coupons/:id", async (req: AuthedRequest, res: Response) => {
  const deleted = await Coupon.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "coupon not found" });
  res.status(204).end();
});

function readCouponBody(body: Record<string, unknown>) {
  const expiresAt = body?.expiresAt ? new Date(String(body.expiresAt)) : null;
  return {
    code: String(body?.code ?? "").trim().toUpperCase(),
    percentOff: Math.max(1, Math.min(100, Number(body?.percentOff) || 0)),
    active: body?.active !== false,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
  };
}

/** A duplicate code hits Mongo's unique index — surface that as a plain message instead of a raw driver error. */
function couponErrorMessage(e: unknown): string {
  const message = (e as Error)?.message ?? "";
  if (message.includes("E11000")) return "a coupon with that code already exists";
  return message || "could not save the coupon";
}

export default router;
