import { Router, Response } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
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

/**
 * Orbit AI — the in-app support assistant.
 *
 * Authenticated only. The assistant answers from a product reference rather
 * than from anything account-specific, but a model call costs money on every
 * request, and an open endpoint is a bill someone else gets to run up.
 *
 * Nothing is stored. The conversation lives in the browser and is posted back
 * with each question, which keeps the server stateless and means there is no
 * transcript to retain, expire, or hand over. If reviewing what people actually
 * ask becomes worth having — it is the best docs backlog there is — that is a
 * deliberate addition with a retention policy, not a side effect of chatting.
 *
 * Metered against the workspace, not the account: the Orbit tier and its
 * question quota are bought per workspace like everything else, so the routes
 * are mounted under `/api/workspaces/:wid/orbit` and every question is checked
 * and spent against that workspace's subscription.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);

const WINDOW_MS = 60 * 60 * 1000;

/** Per past turn. Long enough for a real answer, short enough to bound the prompt. */
const MAX_TURN_CHARS = 4000;

/**
 * In-process request counts, keyed by workspace.
 *
 * Deliberately not in Mongo: this is throttling, not accounting. Losing the
 * counts on restart costs one workspace a few extra questions, which is cheaper
 * than a database round trip on every message — the durable count that decides
 * what someone is entitled to is `orbitUsed` on the subscription.
 *
 * This does a different job from the quota. The quota is billing: it says how
 * many questions a cycle includes. This is abuse control: it stops a workspace
 * with two thousand questions left from spending them all in a minute through a
 * script, which is what would turn a plan into an unbounded provider bill.
 */
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

  res.json({
    configured: orbitConfigured(),
    plan: {
      slug: plan.slug,
      name: plan.name,
      tier: plan.modelTier,
      monthlyQuota: plan.monthlyQuota,
      maxQuestionChars: plan.maxQuestionChars,
    },
    models: ORBIT_MODELS.filter((m) => providerReady(m.provider)).map((m) => ({
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

  const question = String(req.body?.question ?? "").trim().slice(0, plan.maxQuestionChars);
  if (!question) {
    return res.status(400).json({ error: "Ask a question first." });
  }

  // The chosen model is a preference, not a instruction: an unknown id falls
  // back to the default rather than erroring, because the id comes from a
  // browser that may have been open since before a model was retired.
  const modelId = typeof req.body?.model === "string" ? req.body.model : undefined;

  // The quota check and the spend both happen inside `askOrbit`, against the
  // host — that is what keeps "never charge for an unanswered question" true
  // for every embedder rather than depending on each route remembering it. A
  // 402 comes back here as an ordinary failed result.
  const result = await askOrbit(question, {
    history: readHistory(req.body?.history, plan.maxHistoryTurns),
    modelId,
    host: quantalogOrbitHost,
    tenantId: ws.id,
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  // `model` comes back because it may not be the one that was asked for — the
  // chain falls through on a rate limit, and the UI says which one answered.
  res.json({
    reply: result.reply,
    suggestions: result.suggestions,
    model: result.model,
    modelLabel: result.modelLabel,
    // Sent back so the panel can count down without a second round trip. Read
    // after the spend, so it is the figure the next question will face.
    remaining: await remainingQuestions(ws.id, plan),
  });
});

export default router;
