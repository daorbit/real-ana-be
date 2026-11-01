import {
  CHANGE_ACTIONS,
  EXPERIMENT_DEVICES,
  EXPERIMENT_PAGE_MODES,
  EXPERIMENT_TYPES,
  GOAL_TYPES,
  type ChangeAction,
  type ExperimentType,
} from "./models/Experiment.js";

const VARIANT_KEYS = ["control", "b", "c", "d"] as const;
const MAX_CHANGES = 20;
const MAX_PATTERNS = 20;
const ALLOWED_ATTRS = ["href", "src", "alt", "placeholder"];

export type ChangeDraft = { selector: string; action: ChangeAction; attr: string; value: string };
export type VariantDraft = { key: string; name: string; weight: number; redirectUrl: string; changes: ChangeDraft[] };

export type ExperimentDraft = {
  name: string;
  siteId: string;
  key: string;
  type: ExperimentType;
  pages: { mode: string; patterns: string[] };
  devices: string;
  goal: { type: "page" | "event"; value: string };
  variants: VariantDraft[];
};

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

export function slugKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function validUrl(value: string): boolean {
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseChange(raw: unknown): ChangeDraft | string {
  const c = (raw ?? {}) as Record<string, unknown>;
  const selector = str(c.selector, 300);
  if (!selector) return "every change needs a CSS selector";
  const action = oneOf(c.action, CHANGE_ACTIONS, "text");
  const attr = action === "attr" ? str(c.attr, 20).toLowerCase() : "";
  if (action === "attr" && !ALLOWED_ATTRS.includes(attr)) return `attribute must be one of ${ALLOWED_ATTRS.join(", ")}`;
  const value = str(c.value, 2000);
  if (action !== "hide" && !value) return "every change needs a value";
  if (action === "attr" && (attr === "href" || attr === "src") && !validUrl(value)) return "links and images need a full URL or a path starting with /";
  return { selector, action, attr, value: action === "hide" ? "" : value };
}

function parseVariant(raw: unknown, index: number, type: ExperimentType): VariantDraft | string {
  const v = (raw ?? {}) as Record<string, unknown>;
  const key = VARIANT_KEYS[index];
  const name = str(v.name, 60) || (index === 0 ? "Original" : `Variant ${key.toUpperCase()}`);
  const weight = Math.round(Number(v.weight));
  if (!Number.isFinite(weight) || weight < 1 || weight > 99) return "each variant needs a share between 1% and 99%";

  let redirectUrl = "";
  let changes: ChangeDraft[] = [];
  if (index > 0 && type === "split") {
    redirectUrl = str(v.redirectUrl, 500);
    if (!validUrl(redirectUrl)) return `${name} needs a page address to send visitors to`;
  }
  if (index > 0 && type === "changes") {
    const list = Array.isArray(v.changes) ? v.changes.slice(0, MAX_CHANGES) : [];
    if (!list.length) return `${name} needs at least one change`;
    const parsed = list.map(parseChange);
    const error = parsed.find((p): p is string => typeof p === "string");
    if (error) return error;
    changes = parsed as ChangeDraft[];
  }
  return { key, name, weight, redirectUrl, changes };
}

export function parseExperimentDraft(body: unknown): ExperimentDraft | string {
  if (!body || typeof body !== "object") return "test details are required";
  const b = body as Record<string, unknown>;

  const name = str(b.name, 80);
  if (!name) return "name is required";
  const siteId = str(b.siteId, 64);
  if (!siteId) return "site is required";
  const type = oneOf(b.type, EXPERIMENT_TYPES, "changes");
  const key = slugKey(str(b.key, 60) || name);
  if (key.length < 2) return "test key must be at least two letters or numbers";

  const pagesRaw = (b.pages ?? {}) as Record<string, unknown>;
  const mode = oneOf(pagesRaw.mode, EXPERIMENT_PAGE_MODES, "all");
  const patterns = Array.isArray(pagesRaw.patterns)
    ? pagesRaw.patterns.map((p) => str(p, 200)).filter((p) => p.startsWith("/")).slice(0, MAX_PATTERNS)
    : [];
  if (mode !== "all" && !patterns.length) return "add at least one page path starting with /";

  const goalRaw = (b.goal ?? {}) as Record<string, unknown>;
  const goalType = oneOf(goalRaw.type, GOAL_TYPES, "page");
  const goalValue = str(goalRaw.value, 200);
  if (!goalValue) return "pick the goal visitors should reach";
  if (goalType === "page" && !goalValue.startsWith("/")) return "a goal page must be a path starting with /";

  const variantsRaw = Array.isArray(b.variants) ? b.variants.slice(0, VARIANT_KEYS.length) : [];
  if (variantsRaw.length < 2) return "a test needs the original and at least one variant";
  const variants = variantsRaw.map((v, i) => parseVariant(v, i, type));
  const variantError = variants.find((v): v is string => typeof v === "string");
  if (variantError) return variantError;
  const parsedVariants = variants as VariantDraft[];
  if (parsedVariants.reduce((sum, v) => sum + v.weight, 0) !== 100) return "variant shares must add up to 100%";

  return {
    name,
    siteId,
    key,
    type,
    pages: { mode, patterns: mode === "all" ? [] : patterns },
    devices: oneOf(b.devices, EXPERIMENT_DEVICES, "all"),
    goal: { type: goalType, value: goalValue },
    variants: parsedVariants,
  };
}
