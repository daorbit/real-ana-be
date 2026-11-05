const HEX = /^#[0-9a-f]{6}$/i;
const LINK = /^https?:\/\/[^\s"'<>]+$/i;
const MAX_BLOCKS = 60;
const MAX_TEXT = 5_000;
export const MAX_CUSTOM_HTML = 100_000;

export const EMAIL_FONTS = {
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',Times,serif",
  rounded: "ui-rounded,'SF Pro Rounded',-apple-system,'Segoe UI',Roboto,Arial,sans-serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const;

export type EmailFont = keyof typeof EMAIL_FONTS;
export type EmailAlign = "left" | "center" | "right";

export interface EmailTheme {
  pageColor: string;
  cardColor: string;
  headingColor: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
  buttonTextColor: string;
  font: EmailFont;
  width: number;
  radius: number;
}

export type EmailBlock =
  | { id: string; type: "brand"; align: EmailAlign }
  | { id: string; type: "heading"; text: string; size: "s" | "m" | "l" | "xl"; align: EmailAlign }
  | { id: string; type: "text"; text: string; size: "s" | "m" | "l"; align: EmailAlign }
  | { id: string; type: "button"; label: string; url: string; align: EmailAlign; fullWidth: boolean }
  | { id: string; type: "image"; url: string; alt: string; link: string; width: number; radius: number }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; height: number }
  | { id: string; type: "columns"; leftTitle: string; leftText: string; rightTitle: string; rightText: string };

export interface EmailDesign {
  theme: EmailTheme;
  blocks: EmailBlock[];
}

export const DEFAULT_THEME: EmailTheme = {
  pageColor: "#f5f5f7",
  cardColor: "#ffffff",
  headingColor: "#1d1d1f",
  textColor: "#424245",
  mutedColor: "#86868b",
  accentColor: "#0071e3",
  buttonTextColor: "#ffffff",
  font: "sans",
  width: 600,
  radius: 18,
};

type Raw = Record<string, unknown>;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function link(value: unknown): string {
  const url = text(value, 1_000).trim();
  return LINK.test(url) ? url : "";
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX.test(value) ? value : fallback;
}

function range(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

const ALIGNS = ["left", "center", "right"] as const;

function parseTheme(value: unknown): EmailTheme {
  const raw = (value && typeof value === "object" ? value : {}) as Raw;
  return {
    pageColor: color(raw.pageColor, DEFAULT_THEME.pageColor),
    cardColor: color(raw.cardColor, DEFAULT_THEME.cardColor),
    headingColor: color(raw.headingColor, DEFAULT_THEME.headingColor),
    textColor: color(raw.textColor, DEFAULT_THEME.textColor),
    mutedColor: color(raw.mutedColor, DEFAULT_THEME.mutedColor),
    accentColor: color(raw.accentColor, DEFAULT_THEME.accentColor),
    buttonTextColor: color(raw.buttonTextColor, DEFAULT_THEME.buttonTextColor),
    font: choice(raw.font, Object.keys(EMAIL_FONTS) as EmailFont[], DEFAULT_THEME.font),
    width: range(raw.width, 420, 720, DEFAULT_THEME.width),
    radius: range(raw.radius, 0, 32, DEFAULT_THEME.radius),
  };
}

function parseBlock(value: unknown, index: number): EmailBlock | null {
  const raw = (value && typeof value === "object" ? value : {}) as Raw;
  const id = text(raw.id, 60) || `block-${index}`;
  const align = choice(raw.align, ALIGNS, "left");

  switch (raw.type) {
    case "brand":
      return { id, type: "brand", align };
    case "heading":
      return { id, type: "heading", text: text(raw.text, 300), size: choice(raw.size, ["s", "m", "l", "xl"] as const, "l"), align };
    case "text":
      return { id, type: "text", text: text(raw.text), size: choice(raw.size, ["s", "m", "l"] as const, "m"), align };
    case "button":
      return { id, type: "button", label: text(raw.label, 60), url: link(raw.url), align, fullWidth: raw.fullWidth === true };
    case "image":
      return {
        id,
        type: "image",
        url: link(raw.url),
        alt: text(raw.alt, 200),
        link: link(raw.link),
        width: range(raw.width, 20, 100, 100),
        radius: range(raw.radius, 0, 32, 12),
      };
    case "divider":
      return { id, type: "divider" };
    case "spacer":
      return { id, type: "spacer", height: range(raw.height, 4, 120, 24) };
    case "columns":
      return {
        id,
        type: "columns",
        leftTitle: text(raw.leftTitle, 120),
        leftText: text(raw.leftText, 1_000),
        rightTitle: text(raw.rightTitle, 120),
        rightText: text(raw.rightText, 1_000),
      };
    default:
      return null;
  }
}

export function parseEmailDesign(value: unknown): EmailDesign {
  const raw = (value && typeof value === "object" ? value : {}) as Raw;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, MAX_BLOCKS) : [];
  return {
    theme: parseTheme(raw.theme),
    blocks: blocks.map(parseBlock).filter((block): block is EmailBlock => block !== null),
  };
}

export function designHasContent(design: EmailDesign): boolean {
  return design.blocks.some((block) => {
    if (block.type === "heading" || block.type === "text") return Boolean(block.text.trim());
    if (block.type === "button") return Boolean(block.label && block.url);
    if (block.type === "image") return Boolean(block.url);
    if (block.type === "columns") return Boolean(block.leftText.trim() || block.rightText.trim());
    return false;
  });
}

export function sanitizeCustomHtml(value: unknown): string {
  return text(value, MAX_CUSTOM_HTML)
    .replace(/<(script|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|form|base|meta\s+http-equiv)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"');
}
