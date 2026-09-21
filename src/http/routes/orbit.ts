import { Router, Response } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
import { User } from "../../modules/identity/models/User.js";
import {
  ORBIT_MODELS,
  askOrbit,
  orbitConfigured,
  providerReady,
  tierAllows,
  type OrbitTurn,
} from "../../modules/orbit/index.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { quotaSummary } from "../../modules/billing/quota.service.js";
import { effectiveOrbitPlan, quantalogOrbitHost } from "../../modules/orbit/orbit-host.js";
import type { OrbitPlanEntry } from "../../modules/orbit/orbit-plans.catalog.js";
import { explainMetricChange, type ExplainMetric } from "../../modules/orbit/explain.js";
import { Site } from "../../modules/analytics/models/Site.js";
import {
  recordExchange,
  listConversations,
  readConversation,
  deleteConversation,
  deleteConversations,
  renameConversation,
} from "../../modules/orbit-history/index.js";
import { planLimit } from "../plan-limit.js";
import { checkImageDataUrl, cloudinaryConfigured, uploadImage } from "../../infra/storage/cloudinary.js";
import { resolveBranding } from "../../modules/branding/branding.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const WINDOW_MS = 60 * 60 * 1000;

/** Per past turn. Long enough for a real answer, short enough to bound the prompt. */
const MAX_TURN_CHARS = 4000;

/** Matches the body-size override for this route in `app.ts`, with room for
 * the base64 overhead and the rest of the JSON envelope. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;


/**
 * Models a plan tier alone does not gate — restricted to the platform's own
 * super admins instead, checked here rather than in the `orbit` package
 * itself, which is written to know nothing about roles or embedders (see the
 * doc comment on `OrbitHost` in modules/orbit/types.ts).
 */
const SUPER_ADMIN_ONLY_MODELS = new Set(["claude"]);

async function isSuperAdmin(req: AuthedRequest): Promise<boolean> {
  if (req.impersonatorId) return false;
  const user = await User.findById(req.userId).select("role");
  return user?.role === "super_admin";
}

const WATERMARK_PUBLIC_ID = process.env.ORBIT_WATERMARK_PUBLIC_ID?.trim();

/** Cloudinary overlay transformation stamping the Orbit mark bottom-right,
 * sized relative to the source image.
 *
 * A layer name with folders in it needs its `/` swapped for `:` — Cloudinary
 * reads the bare slash as the end of the transformation segment, which broke
 * the whole upload (not just the watermark) rather than merely skipping it.
 *
 * Exported so other routes that upload an Orbit-drawn image (the post planner,
 * for one) stamp it the same way instead of repeating this string. */
export function watermarkTransformation(): string | undefined {
  if (!WATERMARK_PUBLIC_ID) return undefined;
  const layer = WATERMARK_PUBLIC_ID.replace(/\//g, ":");
  return `l_${layer},w_0.08,fl_relative,r_max,g_south_east,x_0.03,y_0.03,o_85`;
}


const hits = new Map<string, number[]>();

function rateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);

  // Without this the map grows one entry per user forever. Cheap to do here,
  // and only when someone is actually talking.
  if (hits.size > 500) {
    for (const [id, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(id);
    }
  }

  return recent.length > limit;
}

/**
 * Take only what we recognise from the client's history.
 *
 * The transcript is supplied by the browser, so it is user input like anything
 * else: every turn is length-capped and anything with an unknown role is
 * dropped rather than passed through to the model.
 */
function readHistory(raw: unknown, maxTurns: number): OrbitTurn[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (t): t is { role: string; content: string } =>
        Boolean(t) &&
        typeof t === "object" &&
        typeof (t as { content?: unknown }).content === "string" &&
        ((t as { role?: unknown }).role === "user" ||
          (t as { role?: unknown }).role === "assistant"),
    )
    .map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content.slice(0, MAX_TURN_CHARS),
    }))
    // Keep the most recent turns: the end of a conversation is what the next
    // question refers to. How many is a plan field, because history is the
    // largest part of what a question costs — every past turn is re-sent with
    // the next one.
    .slice(-maxTurns);
}

/**
 * Questions left this cycle: the plan's own remainder plus any purchased
 * credits, which is the number that decides whether the next question is
 * answered.
 */
async function remainingQuestions(workspaceId: string, plan: OrbitPlanEntry) {
  const summary = await quotaSummary(workspaceId);
  if (!summary) return null;
  const { used, addonCredits } = summary.orbit;
  return Math.max(0, plan.monthlyQuota - used) + addonCredits;
}

/**
 * The models this workspace's Orbit plan may pick, and what it has left.
 *
 * Models above the plan's tier are returned `locked`, not omitted. Hiding them
 * would make the picker honest and the upgrade invisible; showing them greyed,
 * with the tier that unlocks them, is what tells someone on Orbit Free that
 * Gemini Flash exists and what it costs. Models whose provider has no key are
 * still dropped entirely — that is a deployment fact, not a plan boundary, and
 * offering one would only fail.
 *
 * The upstream model name and provider stay server-side.
 */
router.get("/status", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const plan = await effectiveOrbitPlan(ws.id);
  const superAdmin = await isSuperAdmin(req);

  res.json({
    configured: orbitConfigured(),
    plan: {
      slug: plan.slug,
      name: plan.name,
      tier: plan.modelTier,
      monthlyQuota: plan.monthlyQuota,
      maxQuestionChars: plan.maxQuestionChars,
      imageGeneration: plan.imageGeneration,
    },
    models: ORBIT_MODELS.filter((m) => providerReady(m.provider))
      .filter((m) => superAdmin || !SUPER_ADMIN_ONLY_MODELS.has(m.id))
      .map((m) => ({
        id: m.id,
        label: m.label,
        hint: m.hint,
        locked: !tierAllows(plan.modelTier, m.tier),
        /** The tier that unlocks it, so the UI can name the upgrade. */
        tier: m.tier,
      })),
  });
});

router.post("/ask", async (req: AuthedRequest, res: Response) => {
  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Orbit is not available on this server." });
  }

  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const plan = await effectiveOrbitPlan(ws.id);

  if (rateLimited(ws.id, plan.hourlyBurst)) {
    return res.status(429).json({
      error: "That is a lot of questions in one hour. Try again later, or use Email support.",
    });
  }

  let question = String(req.body?.question ?? "").trim().slice(0, plan.maxQuestionChars);

  // An attachment, validated and uploaded before the model is asked anything
  // — a bad or oversized image should fail fast rather than after a paid
  // model call. Cloudinary is used for storage only, not for the call
  // itself: Cloudflare reads the original bytes directly, no round trip
  // through a hosted URL needed.
  const rawImage = typeof req.body?.image === "string" ? req.body.image : undefined;
  let imageUrl: string | undefined;

  if (rawImage) {
    if (!cloudinaryConfigured()) {
      return res.status(503).json({ error: "Image uploads are not configured on this server." });
    }

    const checked = checkImageDataUrl(rawImage, MAX_IMAGE_BYTES);
    if ("error" in checked) return res.status(400).json({ error: checked.error });

    try {
      const uploaded = await uploadImage({
        file: rawImage,
        folder: `orbit/${ws.id}`,
        publicId: `orbit-${ws.id}-${Date.now()}`,
      });
      imageUrl = uploaded.url;
    } catch (e) {
      console.error("[orbit] image upload failed:", (e as Error).message);
      return res.status(502).json({ error: "That image could not be uploaded. Try again." });
    }

    // Sending an image with nothing typed is a valid way to ask "what is
    // this" — the model still needs a prompt, so one stands in for it.
    if (!question) question = "What's in this image?";
  }

  // Explicit rather than inferred from the question's wording — the same
  // reasoning as the composer's own toggle: a model guessing "draw a plan
  // for my week" is a picture request would be wrong far more often than it
  // would be a helpful shortcut. Meaningless alongside an attached image —
  // reading and drawing are mutually exclusive — so the toggle is ignored
  // rather than erroring, the same tolerance an unrecognised `model` gets.
  const generateImage = Boolean(req.body?.generateImage) && !rawImage;

  // Gated on the Orbit plan's own flag, not the question quota below — a
  // Starter workspace with questions left still can't draw, so the browser
  // needs a clear "upgrade" answer rather than a quota error that implies
  // waiting for the next cycle would fix it.
  if (generateImage && !plan.imageGeneration) {
    return planLimit(res, "Drawing pictures is part of Orbit Pro.", {
      kind: "orbit_image_generation",
    }, "plan_required");
  }

  if (!question) {
    return res.status(400).json({
      error: generateImage ? "Say what to draw." : "Ask a question first.",
    });
  }

  // The chosen model is a preference, not a instruction: an unknown id falls
  // back to the default rather than erroring, because the id comes from a
  // browser that may have been open since before a model was retired.
  const modelId = typeof req.body?.model === "string" ? req.body.model : undefined;

  // `/status` already hides these from anyone who isn't a super admin, but a
  // request can name a model id directly without going through that list —
  // barring them here as well is what actually enforces it.
  const superAdmin = await isSuperAdmin(req);
  const exclude = superAdmin ? [] : [...SUPER_ADMIN_ONLY_MODELS];

  // The thread this question continues, when the browser is carrying on a
  // saved one. Validated against the workspace inside the history module — an
  // id from a stale tab starts a new thread rather than failing the question.
  const conversationId =
    typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined;

  const startedAt = Date.now();

  /*
   * Stops the model call when the browser hangs up.
   *
   * Pressing stop in the panel aborts the request, which closes the socket;
   * without this the call it was paying for runs to completion and is charged
   * for anyway, into a response nobody will read. Node fires `close` on the
   * request for a normal finish too, so the listener is removed as soon as
   * there is an answer — see the `finally` below.
   */
  const hungUp = new AbortController();
  const onClose = () => hungUp.abort();
  req.on("close", onClose);

  // The quota check and the spend both happen inside `askOrbit`, against the
  // host — that is what keeps "never charge for an unanswered question" true
  // for every embedder rather than depending on each route remembering it. A
  // 402 comes back here as an ordinary failed result.
  let result;
  try {
    result = await askOrbit(question, {
      // An image turn — reading or drawing — carries no conversation history
      // and ignores `modelId`; `askOrbit` defers to that path before either is
      // read, so passing them here is harmless but unused.
      history: readHistory(req.body?.history, plan.maxHistoryTurns),
      modelId,
      exclude,
      image: rawImage,
      generateImage,
      host: quantalogOrbitHost,
      tenantId: ws.id,
      signal: hungUp.signal,
    });
  } finally {
    req.off("close", onClose);
  }

  // Nobody is listening. Nothing was spent — `askOrbit` returns before the
  // charge once its signal fires — and nothing is stored, because a question
  // that was withdrawn is not part of the conversation. Writing to a closed
  // socket would throw, so this returns without a response at all.
  if (hungUp.signal.aborted) return;

  if (!result.ok) {
    // A spent question allowance is a plan limit, not a failure — it goes back
    // in the shape the dashboard's upgrade dialog reads, like every other cap.
    if (result.quotaExceeded) {
      return planLimit(res, result.error, {
        kind: "orbit_questions",
        label: "Orbit questions",
        quota: plan.monthlyQuota,
      });
    }

    // Store the failure too, but only inside an existing thread. A question
    // that could not be answered is the most useful row in the collection —
    // it is a gap in the knowledge base or a bug, and keeping only successes
    // hides both. Starting a brand new conversation from a failure is the one
    // case worth skipping: it would fill the sidebar with threads that have
    // nothing in them but an error.
    if (conversationId) {
      void recordExchange({
        workspaceId: ws.id,
        userId: req.userId!,
        conversationId,
        question,
        imageUrl,
        turn: {
          reply: result.error,
          failed: true,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    return res.status(result.status).json({ error: result.error });
  }

  // A drawn image comes back as bytes, not a URL — uploaded here rather than
  // handed to the browser raw, both so a saved thread has something to show
  // later and so the response carries an ordinary URL like every other image
  // in the app, not a multi-megabyte data URL on every answer.
  let generatedImageUrl: string | undefined;
  if (result.imageBase64) {
    try {
      // Pro can switch this off in Branding; every other plan is forced on —
      // see `resolveBranding`, which already refuses the stored choice back
      // to true once a workspace isn't Pro.
      const brand = await resolveBranding(ws.id).catch(() => null);
      const watermark = brand?.watermarkAiImages !== false;

      const uploaded = await uploadImage({
        file: `data:image/jpeg;base64,${result.imageBase64}`,
        folder: `orbit/${ws.id}`,
        publicId: `orbit-gen-${ws.id}-${Date.now()}`,
        transformation: watermark ? watermarkTransformation() : undefined,
      });
      generatedImageUrl = uploaded.url;
    } catch (e) {
      console.error("[orbit] generated image upload failed:", (e as Error).message);
      // The answer still goes out — a picture that couldn't be saved is
      // better shown once than not shown at all.
    }
  }

  // Awaited, unlike the failure path, because the response carries the id back
  // — the browser needs it to put the next question in the same thread. It
  // never throws: `recordExchange` returns null on any storage problem and the
  // answer goes out regardless, leaving the conversation in memory only, which
  // is exactly how this route behaved before it stored anything.
  const savedId = await recordExchange({
    workspaceId: ws.id,
    userId: req.userId!,
    conversationId,
    question,
    imageUrl,
    turn: {
      reply: result.reply,
      suggestions: result.suggestions,
      model: result.model,
      modelLabel: result.modelLabel,
      latencyMs: Date.now() - startedAt,
      imageUrl: generatedImageUrl,
      dataDigest: result.dataDigest,
      citations: result.citations,
    },
  });

  // `model` comes back because it may not be the one that was asked for — the
  // chain falls through on a rate limit, and the UI says which one answered.
  res.json({
    reply: result.reply,
    suggestions: result.suggestions,
    model: result.model,
    modelLabel: result.modelLabel,
    imageUrl: generatedImageUrl,
    // Stored with the turn, not recomputed on read.
    //
    // This used to be deliberately unsaved, on the reasoning that a live table
    // stays fresh — but nothing ever refetched it, so reopening a thread simply
    // lost the table. Freshness was also the wrong goal: the prose above it
    // quotes these exact figures, so replacing them with today's would leave an
    // answer arguing with its own evidence. The panel captions it with the date
    // it was taken instead.
    dataDigest: result.dataDigest,
    citations: result.citations,
    /** The thread this landed in. Null when it could not be stored. */
    conversationId: savedId,
    // Sent back so the panel can count down without a second round trip. Read
    // after the spend, so it is the figure the next question will face.
    remaining: await remainingQuestions(ws.id, plan),
  });
});

const VALID_EXPLAIN_METRICS = new Set<ExplainMetric>([
  "visitors", "pageviews", "sessions", "bounceRate",
  "avgSessionMs", "avgTimeOnPageMs", "pagesPerSession",
]);

/** Its own, more generous limit than chat's `hourlyBurst` — a single short
 * targeted call, not a full question, so it shouldn't be bound by a number
 * tuned for that. */
const EXPLAIN_HOURLY_LIMIT = 30;

/**
 * "Why did this change?" — explains one metric's move over the caller's own
 * current dashboard range.
 *
 * Metered like any other Orbit answer. It used to run unmetered on the
 * reasoning that glancing at a stat card should not spend the monthly question
 * pool — but it is a real model call on real data, so left free it was a way
 * to use Orbit indefinitely without it ever reaching the bill. The hourly rate
 * limit below still stands on top of the quota.
 */
router.post("/explain", async (req: AuthedRequest, res: Response) => {
  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Orbit is not available on this server." });
  }

  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const plan = await effectiveOrbitPlan(ws.id);
  if (!plan.dataAccess) {
    return planLimit(res, "Explaining a metric needs a plan with data access.", {
      kind: "orbit_data_access",
    }, "plan_required");
  }

  if (rateLimited(`${ws.id}:explain`, EXPLAIN_HOURLY_LIMIT)) {
    return res.status(429).json({ error: "That is a lot of explanations in one hour. Try again later." });
  }

  const siteId = typeof req.body?.siteId === "string" ? req.body.siteId : "";
  const metric = req.body?.metric as ExplainMetric;
  const rangeKey = typeof req.body?.range === "string" ? req.body.range : "7d";

  if (!siteId) return res.status(400).json({ error: "No site specified." });
  if (!VALID_EXPLAIN_METRICS.has(metric)) return res.status(400).json({ error: "Unknown metric." });

  const site = await Site.findOne({ siteId, workspaceId: ws.id }).select("siteId");
  if (!site) return res.status(404).json({ error: "Site not found." });

  const hungUp = new AbortController();
  const onClose = () => hungUp.abort();
  req.on("close", onClose);

  let result;
  try {
    result = await explainMetricChange({
      siteId,
      metric,
      rangeKey,
      from: req.body?.from,
      to: req.body?.to,
      compare: req.body?.compare,
      compareFrom: req.body?.compareFrom,
      compareTo: req.body?.compareTo,
      // Metered, like every other Orbit answer — see the note on the route.
      host: quantalogOrbitHost,
      tenantId: ws.id,
      signal: hungUp.signal,
    });
  } finally {
    req.off("close", onClose);
  }

  if (hungUp.signal.aborted) return;

  if (!result.ok) {
    // A spent allowance is a plan limit, not a failure — same shape the chat
    // route returns, so the dashboard's upgrade dialog reads it unchanged.
    if (result.quotaExceeded) {
      return planLimit(res, result.error, {
        kind: "orbit_questions",
        label: "Orbit questions",
        quota: plan.monthlyQuota,
      });
    }
    return res.status(result.status).json({ error: result.error });
  }

  res.json({ reply: result.reply });
});

/**
 * The workspace's saved conversations, most recently active first.
 *
 * Scoped to the workspace rather than the asker: Orbit is metered per
 * workspace, so the transcript belongs to the thing that paid for it, and a
 * colleague who can already read the workspace's analytics can read its Orbit
 * history. Each row carries the id of whoever started it so the list can say
 * so.
 */
router.get("/conversations", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const limit = Number(req.query.limit);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const { conversations, nextCursor } = await listConversations(ws.id, {
    limit: Number.isFinite(limit) ? limit : undefined,
    before: cursor,
  });
  res.json({ conversations, nextCursor });
});

/** One conversation with its turns, for restoring it into the panel. */
router.get("/conversations/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const convo = await readConversation(ws.id, String(req.params.id));
  // Missing, another workspace's, and deleted are one answer on purpose — the
  // endpoint must not be usable to find out whether an id is real.
  if (!convo) return res.status(404).json({ error: "Conversation not found." });

  res.json(convo);
});

/**
 * Rename a conversation.
 *
 * The generated title is the first question, which is frequently not what the
 * thread turned out to be about.
 */
router.patch("/conversations/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const title = String(req.body?.title ?? "").trim();
  if (!title) return res.status(400).json({ error: "Give it a title." });

  const renamed = await renameConversation(ws.id, String(req.params.id), title);
  if (!renamed) return res.status(404).json({ error: "Conversation not found." });

  res.json({ ok: true });
});

/**
 * Remove a conversation from the list.
 *
 * A soft delete — the turns stay so a complaint about a bad answer can still be
 * looked at, and the sweep that removes them for real is a separate job.
 */
router.delete("/conversations/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const removed = await deleteConversation(ws.id, String(req.params.id));
  if (!removed) return res.status(404).json({ error: "Conversation not found." });

  res.json({ ok: true });
});

/** Cap on one bulk-delete request — a "select all" on a very long list still
 * has to fit in one call without either side choking on it. */
const MAX_BULK_DELETE = 100;

/** Remove several conversations from the list at once. */
router.post("/conversations/bulk-delete", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.filter((id: unknown): id is string => typeof id === "string").slice(0, MAX_BULK_DELETE)
    : [];
  if (!ids.length) return res.status(400).json({ error: "Nothing to delete." });

  const deleted = await deleteConversations(ws.id, ids);
  res.json({ ok: true, deleted });
});

export default router;
