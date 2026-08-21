/**
 * The fixed catalogue of Orbit AI tiers.
 *
 * A second, independent axis to `plans.ts`. A workspace carries both: an
 * analytics plan (audits, crawls, ranges, reports) and an Orbit plan (questions,
 * models). They are deliberately not the same field, because they are not the
 * same purchase — someone running a small site on analytics Free can be a heavy
 * Orbit user, and making them buy analytics Pro to get a better model would sell
 * them the wrong thing.
 *
 * Like `plans.ts`, everything except price is decided in code. Quotas that can
 * be edited from an admin form are quotas that drift, and here a drifted quota
 * is a bill from a model provider.
 *
 * The tier ladder is built around what each model actually costs us — see
 * `lib/orbit-models.ts`. Orbit Free reaches only models on free provider
 * endpoints, so a free workspace's marginal cost is latency, never spend.
 */

/**
 * Which models a plan may reach. Cumulative and ordered: "standard" includes
 * every "basic" model, "advanced" includes everything.
 *
 * A tier is about our cost, not about quality — the paid-key models are the
 * high tiers because they are the ones with a bill attached, and that happens
 * to correlate with them being better.
 */
export const ORBIT_TIERS = ["basic", "standard", "advanced"] as const;
export type OrbitTier = (typeof ORBIT_TIERS)[number];

/** Position in the ladder, for "does this plan reach that model" comparisons. */
export const ORBIT_TIER_RANK: Record<OrbitTier, number> = {
  basic: 0,
  standard: 1,
  advanced: 2,
};

export type OrbitPlanEntry = {
  slug: string;
  name: string;
  description: string;
  /** Questions per billing cycle. Spent only on an answer that actually arrived. */
  monthlyQuota: number;
  /** The highest model tier this plan may reach. */
  modelTier: OrbitTier;
  /**
   * How much conversation is carried into the prompt.
   *
   * A plan field rather than a constant because history is the largest part of
   * what a question costs: every past turn is re-sent with the next question, so
   * twelve turns is several times the spend of four for the same answer.
   */
  maxHistoryTurns: number;
  /** Longest question accepted, in characters. */
  maxQuestionChars: number;
  /**
   * Questions per hour before being asked to slow down.
   *
   * Separate from `monthlyQuota` and doing a different job: the quota is
   * billing, this is burst abuse. A user with 2000 questions left should still
   * not be able to spend them all in a minute through a script.
   */
  hourlyBurst: number;
  /**
   * Whether Orbit may answer from this workspace's own analytics and SEO data
   * rather than only from the product reference.
   *
   * Not yet wired into the prompt — the flag exists so the plan boundary is
   * decided in one place before the feature lands, rather than being retrofitted
   * across the catalogue later.
   */
  dataAccess: boolean;
  /** Display order on the pricing page; lower first. */
  sortOrder: number;
  features: string[];
};

export const ORBIT_PLAN_CATALOG: OrbitPlanEntry[] = [
  {
    slug: "orbit-free",
    name: "Orbit Free",
    description: "Ask Orbit about your setup, on open models.",
    // Enough to find out whether Orbit is useful, short enough that someone who
    // finds it useful runs out. Costs us nothing: basic tier is free endpoints.
    monthlyQuota: 20,
    modelTier: "basic",
    maxHistoryTurns: 4,
    maxQuestionChars: 500,
    hourlyBurst: 10,
    dataAccess: false,
    sortOrder: 0,
    features: ["Open-weight models", "20 questions a month"],
  },
  {
    slug: "orbit-starter",
    name: "Orbit Starter",
    description: "Daily use, with stronger reasoning models.",
    monthlyQuota: 300,
    modelTier: "standard",
    maxHistoryTurns: 8,
    maxQuestionChars: 2000,
    hourlyBurst: 30,
    dataAccess: false,
    sortOrder: 1,
    features: ["Everything in Orbit Free", "Reasoning models", "Longer conversations"],
  },
  {
    slug: "orbit-pro",
    name: "Orbit Pro",
    description: "Every model, and answers that read your own data.",
    monthlyQuota: 2000,
    modelTier: "advanced",
    maxHistoryTurns: 12,
    maxQuestionChars: 2000,
    hourlyBurst: 100,
    dataAccess: true,
    sortOrder: 2,
    features: [
      "Everything in Orbit Starter",
      "Gemini Flash",
      "Answers from your own analytics",
    ],
  },
];

/** The tier a workspace gets when it has never bought one. */
export const DEFAULT_ORBIT_PLAN_SLUG = "orbit-free";

export function getOrbitPlanEntry(slug: string): OrbitPlanEntry | undefined {
  return ORBIT_PLAN_CATALOG.find((p) => p.slug === slug);
}

/**
 * The plan to apply for a workspace, falling back to Free.
 *
 * An unknown slug — a retired tier still on an old subscription row — resolves
 * to Free rather than to nothing, because "no plan" would mean the assistant
 * silently stops answering for someone who is paying us.
 */
export function resolveOrbitPlan(slug?: string | null): OrbitPlanEntry {
  return (
    (slug ? getOrbitPlanEntry(slug) : undefined) ??
    getOrbitPlanEntry(DEFAULT_ORBIT_PLAN_SLUG)!
  );
}

/**
 * Whether a plan on `planTier` may use a model on `modelTier`.
 *
 * Always true: model access is no longer tier-gated, only quota/history/burst
 * are.
 */
export function tierAllows(_planTier: OrbitTier, _modelTier: OrbitTier): boolean {
  return true;
}
