import {
  POPUP_DEVICES,
  POPUP_LAYOUTS,
  POPUP_PAGE_MODES,
  POPUP_TRIGGERS,
  type PopupDevices,
  type PopupLayout,
  type PopupPageMode,
  type PopupTrigger,
} from "./models/Popup.js";

const MAX_PATTERNS = 10;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export type PopupDraft = {
  name: string;
  siteId: string;
  formId: string;
  formTitle: string;
  enabled: boolean;
  trigger: { type: PopupTrigger; delaySeconds: number; scrollPercent: number };
  layout: PopupLayout;
  showAgainDays: number;
  pages: { mode: PopupPageMode; patterns: string[] };
  devices: PopupDevices;
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined) return fallback;
  return allowed.includes(value as T) ? (value as T) : null;
}

function wholeNumber(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

function parsePatterns(raw: unknown): string[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "pages must be a list";
  const patterns = raw.map((p) => String(p ?? "").trim()).filter(Boolean);
  if (patterns.length > MAX_PATTERNS) return `up to ${MAX_PATTERNS} page rules`;
  for (const p of patterns) {
    if (!p.startsWith("/") || /\s/.test(p) || p.length > 200) return `"${p}" must be a path starting with /`;
  }
  return [...new Set(patterns)];
}

export function parsePopupDraft(body: unknown): PopupDraft | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const trigger = (b.trigger ?? {}) as Record<string, unknown>;
  const pages = (b.pages ?? {}) as Record<string, unknown>;

  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return "name required";

  const siteId = String(b.siteId ?? "").trim();
  if (!siteId) return "pick a site";

  const formId = String(b.formId ?? "").trim();
  if (!OBJECT_ID.test(formId)) return "pick a form";

  const triggerType = oneOf(trigger.type, POPUP_TRIGGERS, "delay");
  if (!triggerType) return "unknown trigger";
  const delaySeconds = wholeNumber(trigger.delaySeconds, 0, 120, 8);
  if (delaySeconds === null) return "delay must be between 0 and 120 seconds";
  const scrollPercent = wholeNumber(trigger.scrollPercent, 10, 100, 50);
  if (scrollPercent === null) return "scroll depth must be between 10% and 100%";

  const layout = oneOf(b.layout, POPUP_LAYOUTS, "modal");
  if (!layout) return "unknown layout";
  const devices = oneOf(b.devices, POPUP_DEVICES, "all");
  if (!devices) return "unknown device setting";
  const mode = oneOf(pages.mode, POPUP_PAGE_MODES, "all");
  if (!mode) return "unknown page setting";

  const showAgainDays = wholeNumber(b.showAgainDays, 0, 365, 7);
  if (showAgainDays === null) return "show again must be between 0 and 365 days";

  const patterns = parsePatterns(pages.patterns);
  if (typeof patterns === "string") return patterns;
  if (mode !== "all" && !patterns.length) return "add at least one page";

  return {
    name,
    siteId,
    formId,
    formTitle: String(b.formTitle ?? "").trim().slice(0, 160),
    enabled: b.enabled === undefined ? true : Boolean(b.enabled),
    trigger: { type: triggerType, delaySeconds, scrollPercent },
    layout,
    showAgainDays,
    pages: { mode, patterns: mode === "all" ? [] : patterns },
    devices,
  };
}
