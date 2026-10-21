export const SHARE_PANEL_DEFAULTS: Record<string, boolean> = {
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

export function readSharePanels(raw: unknown): Record<string, boolean> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const [key, fallback] of Object.entries(SHARE_PANEL_DEFAULTS)) {
    out[key] = o[key] === undefined ? fallback : Boolean(o[key]);
  }
  return out;
}
