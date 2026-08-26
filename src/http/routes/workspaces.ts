import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { Event } from "../../modules/analytics/models/Event.js";
import { SeoReport } from "../../modules/seo/models/SeoReport.js";
import { Competitor } from "../../modules/seo/models/Competitor.js";
import { CompetitorSnapshot } from "../../modules/seo/models/CompetitorSnapshot.js";
import { CrawlReport } from "../../modules/seo/models/CrawlReport.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import {
  computeStats,
  computeFunnel,
  computeUserFlow,
  computeRetention,
  computeGoals,
  exportEvents,
  resolveWindow,
  parseFilters,
  parseCompareMode,
  compareBreakdown,
  COMPARABLE_DIMENSION_KEYS,
  EXPORT_COLUMNS,
  TRACKER_VERSION,
  type FunnelStep,
  type GoalDef,
} from "../../modules/analytics/stats.service.js";
import ExcelJS from "exceljs";
import { ApiKey } from "../../modules/identity/models/ApiKey.js";
import { Goal } from "../../modules/analytics/models/Goal.js";
import { Funnel } from "../../modules/analytics/models/Funnel.js";
import { Project } from "../../modules/workspace/models/Project.js";
import { generateKey } from "../middleware/api-key.js";
import { canCreateSite, canUseRange, canUseCompare, currentPlan, assignFreePlan, quotaSummary } from "../../modules/billing/quota.service.js";
import { invalidateSite } from "../../modules/billing/event-quota.js";
import { Subscription } from "../../modules/billing/models/Subscription.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { WorkspaceInvite } from "../../modules/workspace/models/WorkspaceInvite.js";
import { resolveAccess, isDenied, accessibleWorkspaces, requireWorkspace } from "../../modules/workspace/access.service.js";
import { askOrbit, orbitConfigured } from "../../modules/orbit/index.js";
import { quantalogOrbitHost } from "../../modules/orbit/orbit-host.js";
import { parsePlan } from "../../modules/social/plan-parse.js";

const router = Router();
router.use(requireAuth);
// A demo session may read every workspace route but write none.
router.use(blockDemoWrites);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Normalise the tracker options a client sends.
 *
 * Stored for snippet rebuilding only, but still bounded — these end up in an
 * HTML attribute, and an unbounded list would produce a script tag no one can
 * paste. `clicks`/`errors` default to on, matching the tracker.
 */
function parseTrackerOptions(raw: unknown) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((s) => s.slice(0, 200));

  return {
    dnt: !!o.dnt,
    hash: !!o.hash,
    clicks: o.clicks === undefined ? true : !!o.clicks,
    errors: o.errors === undefined ? true : !!o.errors,
    ignorePages: list(o.ignorePages),
    allowParams: list(o.allowParams),
    domain: String(o.domain ?? "").trim().slice(0, 253),
  };
}

function selectSiteIds(
  sites: Array<{ siteId?: unknown }>,
  requested: unknown,
): string[] {
  const owned = sites.map((s) => String(s.siteId));

  const raw = Array.isArray(requested)
    ? requested
    : typeof requested === "string" && requested
      ? requested.split(",")
      : [];
  const wanted = new Set(raw.map((s) => String(s).trim()).filter(Boolean));

  if (wanted.size === 0) return owned;
  return owned.filter((id) => wanted.has(id));
}

/**
 * Create a workspace.
 *
 * Uncapped: a workspace is the billable unit, so there is no account-wide
 * allowance to check — the account simply ends up with another workspace on the
 * Free plan, which it can upgrade separately.
 *
 * The Free plan is assigned immediately rather than left for the first
 * purchase, because every quota check reads the workspace's own subscription
 * and a workspace without one would 402 on every route the moment it was made.
 */
router.post("/", async (req: AuthedRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const ws = await Workspace.create({
      userId: req.userId,
      name,
      slug: slugify(name) || nanoid(6),
    });
    // The creator's own membership. Written here rather than inferred from
    // `Workspace.userId` so that access is one mechanism with one lookup — the
    // owner is a member like everyone else, just the one who cannot be removed.
    await Membership.create({ workspaceId: ws.id, userId: req.userId, role: "owner" });
    await assignFreePlan(ws.id, req.userId as string);
    // Same shape as the list route, so the client can drop it straight into
    // the cache without a second fetch to learn what plan it landed on.
    res.status(201).json({
      ...ws.toObject(),
      role: "owner",
      billing: await quotaSummary(ws.id),
    });
  } catch (err) {
    console.error("createWorkspace failed:", err);
    res.status(500).json({ error: "could not create workspace" });
  }
});

/**
 * The workspaces this account can reach, each with the plan it is on.
 *
 * Billing is attached here rather than to the profile because a plan belongs to
 * a workspace: whichever workspaces this route returns are exactly the ones the
 * caller may spend or upgrade.
 *
 * Driven by membership, so a workspace shared with the caller appears exactly
 * like one they created — with `role` saying which it is, since that decides
 * what the client offers them.
 */
router.get("/", async (req: AuthedRequest, res: Response) => {
  const accessible = await accessibleWorkspaces(req.userId as string);

  res.json(
    await Promise.all(
      accessible.map(async ({ workspace, role }) => ({
        ...workspace.toObject(),
        role,
        billing: await quotaSummary(workspace.id),
      })),
    ),
  );
});

/**
 * One workspace's plan and usage, on its own.
 *
 * The same `billing` object the list route attaches to every workspace, but
 * reachable without refetching the list. Usage changes constantly — every
 * audit, crawl and Orbit question moves it — while the list around it (names,
 * roles, membership) almost never does, so refreshing a counter by refetching
 * every workspace means N subscription lookups and N site counts to update one
 * number.
 *
 * That cost is why counters went stale rather than being refreshed: the cheap
 * correct call did not exist, so nothing called it.
 */
router.get("/:wid/usage", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const summary = await quotaSummary(ws.id);
  // Null means no subscription row, which should not happen — creating a
  // workspace assigns Free — but a 404 says so honestly rather than handing the
  // client a null it will read as "no quota left".
  if (!summary) return res.status(404).json({ error: "this workspace has no billing record" });

  res.json(summary);
});

// Create site under workspace
router.post("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const { name, platform, domain, framework, bundleId, trackerOptions } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  // Web sites are still domain-bound (that's what the tracker snippet installs
  // against); app sites are identified by bundleId instead.
  if (platform !== "app" && !domain)
    return res.status(400).json({ error: "domain required" });

  const allowed = await canCreateSite(ws.id);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const site = await Site.create({
    workspaceId: ws.id,
    userId: req.userId,
    name,
    platform: platform === "app" ? "app" : "web",
    domain: domain ?? "",
    framework: framework ?? "other",
    bundleId: bundleId ?? "",
    siteId: nanoid(16),
    trackerOptions: parseTrackerOptions(trackerOptions),
  });
  res.status(201).json(site);
});

// List sites in workspace
router.get("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
  res.json(sites);
});

/**
 * Update a site's stored tracker options.
 *
 * Changing these does not change what the site reports — the pasted script tag
 * is what the tracker actually reads. This only updates what the dashboard
 * rebuilds the snippet from, so the user is told to re-copy.
 */
router.patch(
  "/:wid/sites/:siteId/options",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "editor");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: access.workspace.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });

    site.set("trackerOptions", parseTrackerOptions(req.body));
    await site.save();
    res.json(site);
  },
);

/* ---------------------------- public sharing ---------------------------- */

/**
 * The panels a public dashboard can show, and their defaults.
 *
 * The originals default to true — that is what every existing shared link
 * already publishes. Everything added later defaults to false: a workspace
 * that was already sharing must not start exposing new breakdowns because we
 * shipped a release. Turning one on is the owner's decision.
 */
const SHARE_PANEL_DEFAULTS: Record<string, boolean> = {
  totals: true,
  trend: true,
  pages: true,
  sources: true,
  countries: true,
  devices: true,

  browsers: false,
  operatingSystems: false,
  entryPages: false,
  exitPages: false,
  languages: false,
  channels: false,
  engagement: false,
  visitorSplit: false,
};

function readPanels(raw: unknown): Record<string, boolean> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  // Unknown keys are dropped rather than stored — the public route reads this
  // to decide what to publish, so it must only ever contain fields we know.
  for (const [key, fallback] of Object.entries(SHARE_PANEL_DEFAULTS)) {
    out[key] = o[key] === undefined ? fallback : Boolean(o[key]);
  }
  return out;
}

/** The owner-facing share state, assembled the same way from GET and PUT. */
function shareState(ws: NonNullable<Awaited<ReturnType<typeof Workspace.findOne>>>) {
  return {
    enabled: Boolean(ws.get("shareEnabled")),
    token: ws.get("shareToken") ?? null,
    panels: readPanels(ws.get("sharePanels")),
    views: ws.get("shareViews") ?? 0,
    lastViewedAt: ws.get("shareLastViewedAt") ?? null,
  };
}

/** Current share state for a workspace. */
router.get("/:wid/share", async (req: AuthedRequest, res: Response) => {
  // Admin to even see it: the token in this response *is* the public link, so
  // reading it is equivalent to being handed one.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  res.json(shareState(access.workspace));
});

/**
 * Turn sharing on or off, optionally minting a fresh token.
 *
 * `rotate` is the only way to invalidate a link that has already been sent
 * somewhere — disabling alone keeps the token so the same URL can be brought
 * back, which is what someone toggling visibility usually wants.
 */
router.put("/:wid/share", async (req: AuthedRequest, res: Response) => {
  // Publishing a workspace's traffic to anyone with a URL is not day-to-day
  // editing — it needs someone trusted with the workspace itself.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const enabled = Boolean(req.body?.enabled);
  const rotate = Boolean(req.body?.rotate);

  // 32 nanoid chars: the token is the whole credential for an unauthenticated
  // view, so it has to be long enough that guessing is hopeless.
  if (rotate || (enabled && !ws.get("shareToken"))) {
    ws.set("shareToken", `pk_${nanoid(32)}`);
    // A new link is a new audience — carrying the old count over would make
    // the number meaningless.
    if (rotate) {
      ws.set("shareViews", 0);
      ws.set("shareLastViewedAt", null);
    }
  }
  ws.set("shareEnabled", enabled);
  // Only touch panels when the client sends them, so toggling sharing on and
  // off does not silently reset a customised selection.
  if (req.body?.panels !== undefined) {
    ws.set("sharePanels", readPanels(req.body.panels));
  }
  await ws.save();

  res.json(shareState(ws));
});

/** Long enough for a LinkedIn caption, short enough to bound the model call. */
const MAX_CAPTION_CHARS = 3000;

/** The networks a caption can be written for, and how each one wants to read. */
const CAPTION_TONES: Record<string, string> = {
  linkedin:
    "LinkedIn: a professional but human first-person post. Three or four short paragraphs, a concrete hook in the first line, and three or four relevant hashtags at the end.",
  facebook:
    "Facebook: warm and conversational, two or three short paragraphs, at most two hashtags.",
  twitter:
    "X (Twitter): one punchy post under 240 characters including the link, at most two hashtags.",
  whatsapp:
    "WhatsApp: a short direct message to a colleague. Two or three sentences, no hashtags.",
  telegram:
    "Telegram: brief and informative, two or three sentences, no hashtags.",
};

/**
 * Write a share caption.
 *
 * Runs through Orbit's model plumbing — the fallback chain, the timeouts, the
 * output sanitising — with its own system prompt, because under the support
 * prompt the model correctly refuses "write me a post" as off-topic.
 *
 * Admin-only, like the rest of sharing: this is metered model spend against the
 * workspace, and the caption describes numbers only an admin can publish.
 *
 * Everything the model is told comes from the server's own record of the
 * workspace, not from the request. A client that could supply the figures could
 * also supply instructions, and the caption goes out under the user's name.
 */
router.post("/:wid/share/caption", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Caption writing is not available on this server." });
  }

  const platform = String(req.body?.platform ?? "linkedin");
  const tone = CAPTION_TONES[platform];
  if (!tone) return res.status(400).json({ error: "Unsupported platform." });

  /**
   * A caption about something the author names, rather than about their
   * dashboard.
   *
   * The scheduled-post composer writes posts on any subject, so it sends the
   * subject and nothing else. Without a topic this stays exactly what it was:
   * a caption describing the workspace's own public dashboard, which is why
   * the share-enabled check below only guards that path.
   */
  const topic = String(req.body?.topic ?? "").trim().slice(0, 500);

  if (topic) {
    const result = await askOrbit(
      `Write the post.\n\nWhat it is about:\n${topic}`,
      {
        systemPrompt:
          "You write social media posts for a person posting under their own name. " +
          `Write for ${tone}\n\n` +
          "Rules: write in the first person. Use only what the author told you — never invent figures, " +
          "dates, links or claims they did not give you. Do not use markdown, headings, bullet characters " +
          "or quotation marks around the post. " +
          "Return the post in the `reply` field and an empty `suggestions` array.",
        host: quantalogOrbitHost,
        tenantId: ws.id,
      },
    );

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ caption: result.reply.trim().slice(0, MAX_CAPTION_CHARS) });
  }

  if (!ws.get("shareEnabled") || !ws.get("shareToken")) {
    return res.status(400).json({ error: "Turn the public dashboard on first." });
  }

  // The figures come from the same place the public page gets them, so the
  // caption cannot claim numbers the link does not actually show.
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);
  const stats = siteIds.length
    ? await computeStats(siteIds, "30d", {}, resolveWindow("30d"))
    : null;

  const publicUrl = `${process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in"}/share/${ws.get("shareToken")}`;

  // Only panels the owner published may be described. Mentioning a breakdown
  // that is switched off would send people to a page missing what was promised.
  const panels = readPanels(ws.get("sharePanels"));
  const visible = Object.entries(panels)
    .filter(([, on]) => on)
    .map(([key]) => key)
    .join(", ");

  const facts = [
    `Workspace name: ${ws.get("name")}`,
    `Public dashboard URL: ${publicUrl}`,
    stats && panels.totals
      ? `Last 30 days: ${stats.visitors} visitors, ${stats.pageviews} pageviews.`
      : "Visitor totals are not published on this dashboard — do not quote any figures.",
    `Sections the page shows: ${visible || "none"}.`,
  ].join("\n");

  const result = await askOrbit(
    `Write the caption.\n\n${facts}`,
    {
      systemPrompt:
        "You write social media captions for people sharing their public web-analytics dashboard, which is hosted on a product called Quantalog. " +
        `Write for ${tone}\n\n` +
        "Rules: write in the first person as the dashboard's owner. Use only the facts given — never invent figures, dates or claims. " +
        "Include the dashboard URL exactly as provided, on its own line. Do not use markdown, headings, bullet characters or quotation marks around the caption. " +
        "Return the caption in the `reply` field and an empty `suggestions` array.",
      host: quantalogOrbitHost,
      tenantId: ws.id,
    },
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({ caption: result.reply.trim().slice(0, MAX_CAPTION_CHARS) });
});

/** One exchange in a scheduling conversation, as the client replays it back. */
type PlanTurn = { role: "user" | "assistant"; content: string };

/** How many exchanges of a planning conversation are carried into the model. */
const MAX_PLAN_TURNS = 12;

/**
 * Plan a scheduled post by conversation.
 *
 * A scheduled post needs two decisions — what it says, and when it goes out —
 * and someone who starts with only the first should not have to work out the
 * rest of the form alone. This lets Orbit ask: it reads everything settled so
 * far, asks the single most useful question still open, and once nothing is
 * open proposes the finished post for the author to confirm.
 *
 * Each turn returns the whole plan rather than a delta, so the composer's
 * fields track the conversation as it happens and the author watches the form
 * fill rather than being handed a result at the end.
 *
 * `done` is the model saying it has everything and is showing its proposal.
 * It is a state, not an action: scheduling happens through the ordinary
 * scheduled-post route, under the author's own hand, after they confirm.
 *
 * Relative dates are resolved against a clock the CLIENT supplies, because
 * "tomorrow at 9" means the author's tomorrow, not the server's. Only the
 * clock and the conversation come from the request — never the rules.
 */
router.post("/:wid/share/plan", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Scheduling with Orbit is not available on this server." });
  }

  const platform = String(req.body?.platform ?? "linkedin");
  const tone = CAPTION_TONES[platform];
  if (!tone) return res.status(400).json({ error: "Unsupported platform." });

  const message = String(req.body?.message ?? "").trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: "Say something for Orbit to work from." });

  // Oldest first, and trimmed: a planning conversation that has run past a
  // dozen exchanges has stopped converging, and replaying all of it only
  // spends more of the author's quota on the same question.
  const turns: PlanTurn[] = Array.isArray(req.body?.turns)
    ? (req.body.turns as unknown[])
      .filter((t): t is PlanTurn =>
        !!t && typeof t === "object"
        && (((t as PlanTurn).role === "user") || ((t as PlanTurn).role === "assistant"))
        && typeof (t as PlanTurn).content === "string")
      .slice(-MAX_PLAN_TURNS)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
    : [];

  // The author's own wall clock. Sent by the client because only the browser
  // knows which zone the person is in, and a schedule resolved in the server's
  // zone lands at the wrong hour.
  const nowLocal = String(req.body?.now ?? "").slice(0, 40) || new Date().toISOString();

  // Whatever the composer's fields already hold, so a conversation started
  // half-way through an edit builds on the post rather than replacing it.
  const current = req.body?.draft && typeof req.body.draft === "object"
    ? JSON.stringify(req.body.draft).slice(0, 4000)
    : "{}";

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Author" : "You"}: ${t.content}`)
    .join("\n");

  const result = await askOrbit(
    [
      "Continue planning the post.",
      `The author's local date and time right now: ${nowLocal}`,
      `The composer's fields as they stand: ${current}`,
      transcript ? `Conversation so far:\n${transcript}` : "",
      `Author: ${message}`,
    ].filter(Boolean).join("\n\n"),
    {
      systemPrompt:
        "You help a person schedule a social media post that will go out under their own name. " +
        `Write any caption for ${tone}\n\n` +
        "Put a single JSON object in the `reply` field and nothing else — no markdown, no code fences, no prose " +
        "around it. Its keys are exactly:\n" +
        '  "message": string — what you say to the author. One short question when something is still open, or a ' +
        "one-line summary of the finished post when nothing is. Never more than two sentences.\n" +
        '  "done": boolean — true only when the caption is written AND the schedule is settled AND, for an ' +
        "Instagram post, an image is already attached, and you are showing the finished post for them to confirm.\n" +
        '  "needsImage": boolean — true when you are waiting on the author to attach an image.\n' +
        '  "caption": string — the post so far, first person, no markdown or surrounding quotes. "" until you ' +
        "have enough to write one.\n" +
        '  "name": string — a short private label for the author\'s own list, at most 60 characters. "" until known.\n' +
        '  "mode": "once" | "repeat".\n' +
        '  "date": "YYYY-MM-DD" — the day a one-off publishes, otherwise "".\n' +
        '  "time": "HH:MM" — 24-hour, the time a one-off publishes, otherwise "".\n' +
        '  "frequency": "daily" | "weekly" | "monthly" — the cadence of a repeating post.\n' +
        '  "hour": integer 0-23, "minute": integer 0-59 — the repeating time of day.\n' +
        '  "weekday": integer 0-6 where 0 is Sunday — the day a weekly post repeats on.\n' +
        '  "dayOfMonth": integer 1-28 — the day a monthly post repeats on.\n\n' +
        "Rules: ask ONE question at a time, and only about something you genuinely cannot infer — never ask again " +
        "about anything the author has already settled or that the composer's fields already hold. Normally you " +
        "need at most three things: what the post is about, when it goes out, and an image. An Instagram post " +
        "cannot publish without an image, so when the fields show none, ask for one and set needsImage true — the " +
        "author attaches it in the composer, and the next turn's fields will show it. On LinkedIn an image is " +
        "optional: offer it once, accept no for an answer, and never ask twice. Always return every key, " +
        "carrying forward what is already decided, so the author's form stays filled between turns. Resolve every " +
        "relative date against the author's local date and time given above, and never return a one-off date and " +
        "time in the past. A date with no stated time means 09:00. Use only what the author told you — never " +
        "invent figures, dates, links or claims they did not give you. Return an empty `suggestions` array.",
      host: quantalogOrbitHost,
      tenantId: ws.id,
      // The author's picked model, honoured as given.
      //
      // An earlier version forced a schema-honouring model here, on the theory
      // that this route needs JSON. Measured, that was wrong twice over: the
      // structured models are the ones currently failing, and DeepSeek — which
      // is not one — returns clean JSON and the best captions of anything in
      // the chain. `parsePlan` handles a fence or a stray sentence, so asking
      // nicely in the prompt is enough.
      // Defaulted to DeepSeek rather than to the chain's own head, which is
      // Gemini — barred below, so without this the route would start on
      // whatever happens to be second.
      modelId: String(req.body?.modelId ?? "").slice(0, 60) || "deepseek",

      // Measured against this exact prompt on 2026-08-21:
      //   deepseek     15s, correct JSON, a caption worth publishing
      //   north-mini   55s, correct JSON, but a caption that only echoes the
      //                instruction back
      //   gpt-oss      returns an empty completion however large its token
      //                budget — it reasons and then writes nothing
      //   gemma        429, the free pool is rate-limited upstream
      //   gemini       503 while it is overloaded, and it is first in the
      //                chain, so it burned the budget before anything else ran
      //
      // Only the two that cannot produce an answer here are barred. Gemini
      // stays in the chat panel's chain, where it is the best model when it is
      // up; this route cannot afford to wait for it to fail first.
      exclude: ["gemini-flash", "gpt-oss"],

      // Long enough for DeepSeek's slow tail and one fallback behind it.
      // Someone is watching a chat panel, and a minute of spinner is worse
      // than an honest "try rewording that" — the composer keeps the
      // conversation, so retrying costs one click.
      budgetMs: 70_000,
    },
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  // A fence, a sentence before the object, a double-encoded string — see
  // `parsePlan` for the shapes models actually return here.
  const parsed = parsePlan(result.reply);
  if (!parsed) {
    // Logged with the model that produced it: an unstructured model failing
    // this consistently is a reason to reorder the chain, and that is invisible
    // if every failure looks the same from the outside.
    console.error(
      `[social] plan reply was not JSON (model ${result.model}): ${result.reply.slice(0, 300)}`,
    );
    return res.status(502).json({ error: "Orbit could not follow that. Try rewording it." });
  }

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  // Every numeric field is clamped rather than rejected: a model that answers
  // "weekday: 7" meant Sunday, and failing the whole turn over it would send
  // the author back to the form they were trying to skip.
  const int = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;

  const caption = str(parsed.caption, MAX_CAPTION_CHARS);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(parsed.date, 10)) ? str(parsed.date, 10) : "";
  const time = /^\d{2}:\d{2}$/.test(str(parsed.time, 5)) ? str(parsed.time, 5) : "";
  const mode = oneOf(parsed.mode, ["once", "repeat"] as const, "once");

  // An Instagram post with no image cannot publish, so it is never finished —
  // checked against the composer's own fields rather than the model's claim.
  const hasImage = !!(req.body?.draft as { image?: string } | undefined)?.image;
  const imageRequired = platform !== "linkedin" && !hasImage;

  // A turn claiming to be finished without a caption, or without the times its
  // own mode depends on, is not finished — treating it as done would put a
  // confirm button under an empty post.
  const complete = !!caption
    && (mode === "repeat" || (!!date && !!time))
    && !imageRequired;

  res.json({
    message: str(parsed.message, 400) || "What should this post be about?",
    done: parsed.done === true && complete,
    needsImage: parsed.needsImage === true || imageRequired,
    caption,
    name: str(parsed.name, 60),
    mode,
    date,
    time,
    frequency: oneOf(parsed.frequency, ["daily", "weekly", "monthly"] as const, "weekly"),
    hour: int(parsed.hour, 0, 23, 9),
    minute: int(parsed.minute, 0, 59, 0),
    weekday: int(parsed.weekday, 0, 6, 1),
    // 29-31 do not exist in every month, so a monthly post pinned there would
    // silently skip February. The composer's own picker stops at 28 too.
    dayOfMonth: int(parsed.dayOfMonth, 1, 28, 1),
  });
});

// Install status for a site — has the tracking script ever reported?
router.get(
  "/:wid/sites/:siteId/status",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req);
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const ws = access.workspace;
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });

    const siteId = site.siteId as string;
    const [eventCount, last] = await Promise.all([
      Event.countDocuments({ siteId }),
      Event.findOne({ siteId }).sort({ ts: -1 }).select("ts"),
    ]);

    res.json({
      siteId,
      installed: eventCount > 0,
      eventCount,
      lastEventAt: last?.ts ?? null,
    });
  },
);

// Aggregate analytics across all sites in a workspace
router.get("/:wid/stats", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select(
    "siteId name trackerVersion",
  );

  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) {
    return res.json({
      range: String(req.query.range ?? "24h"),
      pageviews: 0,
      visitors: 0,
      live: 0,
      topPages: [],
      topReferrers: [],
      devices: [],
      countries: [],
      utmSources: [],
      timeseries: [],
      siteCount: 0,
      outdatedSites: [],
    });
  }

  const inScope = new Set(ids);
  const outdatedSites = sites
    .filter(
      (s) =>
        inScope.has(s.siteId as string) &&
        (s.trackerVersion ?? 1) < TRACKER_VERSION,
    )
    .map((s) => ({ siteId: s.siteId as string, name: s.name as string }));

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  // A baseline the plan doesn't include degrades to "previous" rather than
  // refusing the request — see `canUseCompare`.
  const askedCompare = parseCompareMode(req.query.compare);
  const compare = (await canUseCompare(ws.id, askedCompare)) ? askedCompare : "previous";

  const win = resolveWindow(
    rangeKey,
    req.query.from,
    req.query.to,
    compare,
    req.query.compareFrom,
    req.query.compareTo,
  );
  const filters = parseFilters(req.query.filter);
  // The overlay series is only worth its extra aggregation when the client is
  // actually drawing a comparison.
  const stats = await computeStats(ids, rangeKey, filters, win, compare !== "previous");

  // Score the workspace's goals over the same window/scope. Goals live on the
  // workspace, so they're resolved here rather than inside computeStats (which
  // only knows about siteIds).
  const goalDefs = await Goal.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  const goals = await computeGoals(
    ids,
    goalDefs.map<GoalDef>((g) => ({
      id: g.id,
      name: g.get("name"),
      kind: g.get("kind"),
      match: g.get("match"),
    })),
    rangeKey,
    stats.visitors,
    {},
    win,
  );

  res.json({
    ...stats,
    goals,
    siteCount: ids.length,
    outdatedSites,
    filters,
    // Echo the resolved window so a custom range round-trips to the client.
    window: { since: win.since, until: win.until },
    // Echo the baseline actually used, which may not be the one asked for if
    // the plan does not include it — the picker reads this back to stay honest
    // about what is on screen.
    compare: win.compare,
  });
});

/**
 * One breakdown, current window against its baseline.
 *
 * Separate from the stats payload because comparing every breakdown would
 * double roughly twenty-five aggregations to serve a panel the user may never
 * open. The dashboard calls this per panel, on expand.
 */
router.get("/:wid/stats/compare", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const dimension = String(req.query.dimension ?? "");
  if (!COMPARABLE_DIMENSION_KEYS.includes(dimension)) {
    return res.status(400).json({ error: `unknown dimension: ${dimension}` });
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ dimension, rows: [] });

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const askedCompare = parseCompareMode(req.query.compare);
  const compare = (await canUseCompare(ws.id, askedCompare)) ? askedCompare : "previous";

  const win = resolveWindow(
    rangeKey,
    req.query.from,
    req.query.to,
    compare,
    req.query.compareFrom,
    req.query.compareTo,
  );
  const filters = parseFilters(req.query.filter);
  const rows = await compareBreakdown(ids, dimension, win, filters);

  res.json({ dimension, compare: win.compare, rows });
});

// Export raw events as CSV or XLSX for the current window/scope.
router.get("/:wid/export", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const win = resolveWindow(rangeKey, req.query.from, req.query.to);
  const filters = parseFilters(req.query.filter);
  const format = req.query.format === "csv" ? "csv" : "xlsx";

  const rows = ids.length ? await exportEvents(ids, win, filters) : [];

  const stamp = win.since.toISOString().slice(0, 10);
  const base = `quantalog-events-${stamp}`;

  if (format === "csv") {
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      // Quote when the value contains a comma, quote, or newline; double inner quotes.
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = EXPORT_COLUMNS.join(",");
    const body = rows.map((r) => EXPORT_COLUMNS.map((c) => esc(r[c])).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    return res.send(`${header}\n${body}`);
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Events");
  sheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c, key: c, width: 18 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// --- identified users / journey tracing (dashboard read side) -----------
//
// The write side lives on the Platform API (/v1/track — API-key authed, for
// a customer's own web/mobile app). These are the session-authed reads the
// dashboard itself uses to show that data, same underlying Event rows,
// scoped through the caller's workspace membership instead of a key.

/** Recently active identified users, most recent first. */
router.get("/:wid/users", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ users: [], total: 0, page: 1, pageSize: 10 });

  const search = String(req.query.q ?? "").trim().slice(0, 120);
  const pageSize = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [result] = await Event.aggregate([
    {
      $match: {
        siteId: { $in: ids },
        appUserId: search
          ? { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" }
          : { $ne: "" },
      },
    },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: "$appUserId",
        lastSeen: { $first: "$ts" },
        lastAction: { $first: "$name" },
        siteId: { $first: "$siteId" },
        eventCount: { $sum: 1 },
      },
    },
    { $sort: { lastSeen: -1 } },
    {
      // One round trip for both the page and the count it's paged against —
      // the alternative is two queries that can disagree if a user is traced
      // between them.
      $facet: {
        users: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        total: [{ $count: "count" }],
      },
    },
  ]);

  res.json({
    users: (result?.users ?? []).map((u: any) => ({
      appUserId: u._id,
      lastSeen: u.lastSeen,
      lastAction: u.lastAction,
      siteId: u.siteId,
      eventCount: u.eventCount,
    })),
    total: result?.total?.[0]?.count ?? 0,
    page,
    pageSize,
  });
});

/** One user's full journey, oldest first: every src -> action -> dest step. */
router.get("/:wid/track/:appUserId", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const appUserId = String(req.params.appUserId ?? "").trim();
  if (!appUserId) return res.status(400).json({ error: "appUserId required" });

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ appUserId, events: [] });

  const limit = Math.min(Number(req.query.limit) || 500, 1000);

  const events = await Event.find({ siteId: { $in: ids }, appUserId })
    .sort({ ts: 1 })
    .limit(limit)
    .select("siteId name source destination sessionId ts");

  res.json({
    appUserId,
    events: events.map((e) => ({
      siteId: e.get("siteId"),
      action: e.get("name"),
      src: e.get("source"),
      dest: e.get("destination"),
      // Lets the dashboard group a journey into sessions rather than
      // inferring them from time gaps, which guesses wrong across a long
      // idle period that was really one continuous visit.
      sessionId: e.get("sessionId"),
      ts: e.get("ts"),
    })),
  });
});

// --- goal definitions (conversions) -------------------------------------
router.get("/:wid/goals", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const goals = await Goal.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  res.json(
    goals.map((g) => ({
      id: g.id,
      name: g.get("name"),
      kind: g.get("kind"),
      match: g.get("match"),
    })),
  );
});

router.post("/:wid/goals", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const kind = req.body?.kind === "event" ? "event" : "page";
  const match = String(req.body?.match ?? "").trim().slice(0, 300);
  if (!name || !match) return res.status(400).json({ error: "name and match required" });

  const goal = await Goal.create({ workspaceId: ws.id, name, kind, match });
  res.status(201).json({ id: goal.id, name, kind, match });
});

router.delete("/:wid/goals/:gid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const goal = await Goal.findOne({ _id: req.params.gid, workspaceId: ws.id });
  if (!goal) return res.status(404).json({ error: "goal not found" });
  await goal.deleteOne();
  res.status(204).end();
});

router.post("/:wid/funnel", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  // Funnels are a Starter/Pro feature — Free can view the builder UI but not
  // spend compute on it.
  const plan = await currentPlan(ws.id);
  if (!plan || plan.slug === "free") {
    return res.status(402).json({
      error: "funnels need this workspace on the Starter or Pro plan",
      code: "plan_required",
    });
  }

  const raw = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const steps: FunnelStep[] = raw
    .map((s: { type?: string; value?: string }) => ({
      type: s?.type === "event" ? "event" : "page",
      value: String(s?.value ?? "").slice(0, 300),
    }))
    .filter((s: FunnelStep) => s.value)
    .slice(0, 8);

  if (steps.length < 2) {
    return res.status(400).json({ error: "at least 2 steps required" });
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.body?.sites);
  if (ids.length === 0) return res.json({ steps: [] });

  const rangeKey = String(req.body?.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const win = resolveWindow(rangeKey, req.body?.from, req.body?.to);
  const result = await computeFunnel(ids, steps, rangeKey, win);
  res.json({ steps: result });
});

// --- saved funnel definitions --------------------------------------------
function parseFunnelSteps(raw: unknown): FunnelStep[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((s: { type?: string; value?: string }) => ({
      type: s?.type === "event" ? ("event" as const) : ("page" as const),
      value: String(s?.value ?? "").slice(0, 300),
    }))
    .filter((s) => s.value)
    .slice(0, 8);
}

router.get("/:wid/funnels", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const funnels = await Funnel.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  res.json(
    funnels.map((f) => ({
      id: f.id,
      name: f.get("name"),
      steps: f.get("steps"),
    })),
  );
});

router.post("/:wid/funnels", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const steps = parseFunnelSteps(req.body?.steps);
  if (!name) return res.status(400).json({ error: "name required" });
  if (steps.length < 2) return res.status(400).json({ error: "at least 2 steps required" });

  const funnel = await Funnel.create({ workspaceId: ws.id, name, steps });
  res.status(201).json({ id: funnel.id, name, steps });
});

router.put("/:wid/funnels/:fid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const steps = parseFunnelSteps(req.body?.steps);
  if (!name) return res.status(400).json({ error: "name required" });
  if (steps.length < 2) return res.status(400).json({ error: "at least 2 steps required" });

  const funnel = await Funnel.findOne({ _id: req.params.fid, workspaceId: ws.id });
  if (!funnel) return res.status(404).json({ error: "funnel not found" });
  funnel.set({ name, steps });
  await funnel.save();
  res.json({ id: funnel.id, name, steps });
});

router.delete("/:wid/funnels/:fid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const funnel = await Funnel.findOne({ _id: req.params.fid, workspaceId: ws.id });
  if (!funnel) return res.status(404).json({ error: "funnel not found" });
  await funnel.deleteOne();
  res.status(204).end();
});

// Page-to-page navigation graph for the workspace.
router.get("/:wid/user-flow", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) return res.json({ nodes: [], edges: [] });

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const win = resolveWindow(rangeKey, req.query.from, req.query.to);
  const result = await computeUserFlow(ids, rangeKey, win);
  res.json(result);
});

// Weekly retention cohorts for the workspace.
router.get("/:wid/retention", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) return res.json({ weeks: 6, cohorts: [] });

  const weeks = Math.min(12, Math.max(2, Number(req.query.weeks) || 6));
  const cohorts = await computeRetention(ids, weeks);
  res.json({ weeks, cohorts });
});

// Rename workspace
router.patch("/:wid", async (req: AuthedRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });

  // Admin, not editor: the name is how every member identifies the workspace,
  // so renaming it changes what everyone else is looking at.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { name, slug: slugify(name) || nanoid(6) },
    { new: true },
  );
  res.json(ws);
});

// Delete workspace + its sites + their events
router.delete("/:wid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "owner");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  await Event.deleteMany({ siteId: { $in: ids } });
  await SeoReport.deleteMany({ workspaceId: ws.id });
  await Competitor.deleteMany({ workspaceId: ws.id });
  // Trend rows carry no workspace id, so they are cleared by the site ids the
  // workspace owned — otherwise they outlive both and are unreachable.
  await CompetitorSnapshot.deleteMany({ siteId: { $in: ids } });
  await CrawlReport.deleteMany({ workspaceId: ws.id });
  await Site.deleteMany({ workspaceId: ws.id });
  await Goal.deleteMany({ workspaceId: ws.id });
  // Keys are scoped to the workspace, so they'd otherwise outlive it and keep
  // authenticating against /v1 for a tenant that no longer exists.
  await ApiKey.deleteMany({ workspaceId: ws.id });
  await Project.deleteMany({ workspaceId: ws.id });
  // The plan was bought for this workspace, so it goes with it. Left behind it
  // would hold the unique index on `workspaceId` against a dead id, and count
  // as an active plan in the account's billing summary.
  await Subscription.deleteOne({ workspaceId: ws.id });
  // Everyone's access to it, and any invitations still outstanding — an
  // unaccepted link must not resurrect a membership for a workspace that no
  // longer exists.
  await Membership.deleteMany({ workspaceId: ws.id });
  await WorkspaceInvite.deleteMany({ workspaceId: ws.id });
  await ws.deleteOne();
  // Ingest caches "this site may collect" for a minute. Without this a deleted
  // site keeps accepting beacons until that expires, writing events keyed to a
  // site that no longer exists — rows nothing can read or clean up.
  for (const id of ids) invalidateSite(id);
  res.status(204).end();
});

// Delete a single site + its events
router.delete(
  "/:wid/sites/:siteId",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "editor");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const ws = access.workspace;
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });
    await Event.deleteMany({ siteId: site.siteId });
    await SeoReport.deleteMany({ siteId: site.siteId });
    await Competitor.deleteMany({ siteId: site.siteId });
    await CompetitorSnapshot.deleteMany({ siteId: site.siteId });
    await CrawlReport.deleteMany({ siteId: site.siteId });
    await site.deleteOne();
    // See the workspace delete above: a cached allow decision would otherwise
    // let this site keep ingesting for up to a minute after it is gone.
    invalidateSite(site.siteId as string);
    res.status(204).end();
  },
);

type Placed = { id: string; span: number };

function parseLayout(body: unknown): Placed[] | null {
  if (!Array.isArray(body) || body.length > 50) return null;
  const out: Placed[] = [];
  for (const item of body) {
    const id = (item as Placed)?.id;
    const span = (item as Placed)?.span;
    if (typeof id !== "string" || !id || id.length > 64) return null;
    if (![1, 2, 3, 4].includes(span)) return null;
    out.push({ id, span });
  }
  return out;
}

router.get("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  // null, not [], so the client can tell "never customised" from "emptied".
  res.json({ layout: ws.homeLayout ?? null });
});

router.put("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const layout = parseLayout(req.body);
  if (!layout)
    return res
      .status(400)
      .json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { homeLayout: layout },
    { new: true },
  );
  res.json({ layout: ws?.homeLayout ?? [] });
});

/**
 * Appearance (theme) settings, workspace-scoped — same shape as the client's
 * ThemePrefs. Stored as a plain object rather than validated field-by-field:
 * the FE owns what the keys mean and what a valid value looks like for each
 * one, and a strict schema here would need editing every time Appearance
 * grows a new control. The size cap and plain-object check are the only
 * gates, matching how `homeLayout` above trusts its item shape beyond a
 * basic type check.
 */
function parseThemePrefs(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (JSON.stringify(body).length > 4000) return null;
  return body as Record<string, unknown>;
}

router.get("/:wid/theme", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  // null, not {}, so the client can tell "never customised" from "reset".
  res.json({ theme: ws.themePrefs ?? null });
});

router.put("/:wid/theme", async (req: AuthedRequest, res: Response) => {
  const theme = parseThemePrefs(req.body);
  if (!theme)
    return res.status(400).json({ error: "theme must be a plain object" });
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { themePrefs: theme },
    { new: true },
  );
  res.json({ theme: ws?.themePrefs ?? null });
});

// ---- API keys (platform integration) ----
// Create a key — returns the raw secret ONCE.
router.post("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const { name } = req.body ?? {};
  const { raw, keyHash, prefix } = generateKey();
  const key = await ApiKey.create({
    workspaceId: ws.id,
    userId: req.userId,
    name: name || "Default key",
    keyHash,
    prefix,
  });
  res.status(201).json({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    key: raw,
    createdAt: key.createdAt,
  });
});

// List keys (masked — never returns the raw secret again)
router.get("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const keys = await ApiKey.find({ workspaceId: ws.id, revoked: false }).sort({
    createdAt: -1,
  });
  res.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.get("createdAt"),
    })),
  );
});

// Revoke a key
router.delete("/:wid/keys/:kid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const key = await ApiKey.findOne({ _id: req.params.kid, workspaceId: ws.id });
  if (!key) return res.status(404).json({ error: "key not found" });
  key.set("revoked", true);
  await key.save();
  res.status(204).end();
});

export default router;
