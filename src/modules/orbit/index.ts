/**
 * Orbit — an embeddable support assistant.
 *
 * The public surface of what will become a standalone package. Nothing in this
 * directory imports from the rest of the application: the product it is
 * embedded in supplies entitlements, quota and (optionally) its own data
 * through the `OrbitHost` interface, and Orbit supplies the models, the prompt,
 * the fallback chain and the answer.
 *
 * The rule that keeps it extractable: policy about *who may do what* belongs to
 * the host, and mechanism belongs here. "The Pro plan includes the Pro AI tier"
 * is a pricing decision that differs per embedder; "advanced tier reaches every
 * model" is a fact about Orbit.
 */

export { askOrbit, orbitConfigured } from "./ask.js";
export type { AskOptions, OrbitAnswer, OrbitResult, OrbitTurn } from "./ask.js";

export {
  ORBIT_MODELS,
  availableModels,
  fallbackChain,
  providerReady,
  resolveModel,
} from "./models.js";
export type { ModelProvider, OrbitModel } from "./models.js";

export {
  ORBIT_TIERS,
  ORBIT_TIER_RANK,
  highestTier,
  tierAllows,
} from "./types.js";
export type { OrbitEntitlement, OrbitHost, OrbitTier } from "./types.js";

export { ORBIT_SYSTEM_PROMPT, orbitPromptWithData } from "./prompt.js";
export { sanitiseModelAnswer } from "./output.js";
