/**
 * The contract between Orbit and whatever product embeds it.
 *
 * Orbit is written to become an npm package, so nothing under `src/orbit/` may
 * import from the rest of this codebase — no Mongo models, no plan catalogue,
 * no billing. Everything Orbit needs to know about *who is asking* and *what
 * they are entitled to* arrives through the `OrbitHost` below, which the
 * embedding product implements.
 *
 * The split is deliberate about where policy lives. "Buying the Pro analytics
 * plan includes the Pro AI tier" is a Quantalog pricing decision, not a fact
 * about Orbit — a different embedder will have a different rule, or no plans at
 * all. So Orbit never asks *why* a tenant is on a tier; it asks what the tier
 * is and honours it.
 */

/**
 * Which models a tenant may reach. Cumulative and ordered: `standard` includes
 * every `basic` model, `advanced` includes everything.
 *
 * A tier is about what a model *costs the operator*, not about quality — the
 * models on paid keys sit in the high tiers because they carry a bill, which
 * happens to correlate with them being better.
 */
export const ORBIT_TIERS = ["basic", "standard", "advanced"] as const;
export type OrbitTier = (typeof ORBIT_TIERS)[number];

/** Position in the ladder, for "does this tenant reach that model" comparisons. */
export const ORBIT_TIER_RANK: Record<OrbitTier, number> = {
  basic: 0,
  standard: 1,
  advanced: 2,
};

/** Whether a tenant on `tenantTier` may use a model on `modelTier`. */
export function tierAllows(tenantTier: OrbitTier, modelTier: OrbitTier): boolean {
  return ORBIT_TIER_RANK[modelTier] <= ORBIT_TIER_RANK[tenantTier];
}

/** The strongest of a set of tiers, or `basic` when given none. */
export function highestTier(...tiers: (OrbitTier | null | undefined)[]): OrbitTier {
  return tiers
    .filter((t): t is OrbitTier => Boolean(t))
    .reduce<OrbitTier>((best, t) => (ORBIT_TIER_RANK[t] > ORBIT_TIER_RANK[best] ? t : best), "basic");
}

/**
 * What one tenant may do right now.
 *
 * Deliberately flat values rather than a plan object: Orbit does not care
 * whether these came from a subscription, a grant, a trial, or a hardcoded
 * config, and taking a plan would drag the host's billing vocabulary into the
 * package.
 */
export type OrbitEntitlement = {
  tier: OrbitTier;
  /** Questions per period. Only used for the message when quota runs out. */
  monthlyQuota: number;
  /** How much conversation to carry. The largest driver of what a question costs. */
  maxHistoryTurns: number;
  maxQuestionChars: number;
  /** Questions per hour before throttling. Abuse control, distinct from quota. */
  hourlyBurst: number;
  /** Whether answers may include the tenant's own data, via `dataSummary`. */
  dataAccess: boolean;
};

/**
 * Everything Orbit needs from the product it is embedded in.
 *
 * `tenantId` is opaque to Orbit — a workspace id here, an org id or a user id
 * elsewhere. It is passed back unchanged.
 */
export type OrbitHost = {
  /** This tenant's current entitlement. How it is decided is the host's business. */
  entitlement(tenantId: string): Promise<OrbitEntitlement>;

  /**
   * Whether one more question is allowed, without spending it.
   *
   * Checked before the model call, which is slow and costs money — discovering
   * afterwards that there was no quota means having paid for an answer nobody
   * was entitled to.
   */
  hasQuota(tenantId: string): Promise<boolean>;

  /**
   * Commit one question.
   *
   * Called only once an answer exists. A timeout, a refusal, or an exhausted
   * fallback chain must cost the asker nothing — charging for a question that
   * was never answered is the fastest way to make someone stop asking.
   */
  spendQuota(tenantId: string): Promise<void>;

  /**
   * The tenant's own figures, as plain text, for entitlements with
   * `dataAccess`. Return an empty string when there is nothing to report;
   * Orbit then appends nothing and its "you cannot see their data" rule stands.
   *
   * The host decides what is safe to send to a model provider. Orbit only
   * places it in the prompt.
   */
  dataSummary?(tenantId: string): Promise<string>;
};
