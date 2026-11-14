import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import {
  BIO_APPEARANCES,
  BIO_BACKGROUNDS,
  BIO_BUTTON_STYLES,
  BIO_FONTS,
  BIO_KINDS,
  BIO_PROFILE_LAYOUTS,
  BIO_RELEASE_LAYOUTS,
  BIO_SOCIAL_NETWORKS,
  type BioAppearance,
  type BioBackground,
  type BioButtonStyle,
  type BioFont,
  type BioKind,
  type BioLayout,
  type BioSocialNetwork,
} from "./models/BioPage.js";
import { isBioService } from "./service-catalog.js";

const MAX_LINKS = 30;
const MAX_SOCIALS = 24;
const MAX_ROWS = 40;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const HEX = /^#[0-9a-f]{6}$/i;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "apps", "bio", "docs", "help", "login", "logout", "new", "quantalog",
  "settings", "share", "signup", "support", "www",
]);

type WithId = { _id?: Types.ObjectId };
export type BioLinkDraft = WithId & { label: string; url: string; enabled: boolean };
export type BioSocialDraft = WithId & { network: BioSocialNetwork; url: string; label: string };
export type BioRowDraft = WithId & { service: string; name: string; url: string; action: string; enabled: boolean };
export type BioReleaseDraft = { artworkUrl: string; subtitle: string; releaseDate: string; rows: BioRowDraft[] };
export type BioThemeDraft = {
  appearance: BioAppearance;
  accent: string;
  buttonStyle: BioButtonStyle;
  background: BioBackground;
  layout: BioLayout;
  font: BioFont;
};

export type BioDraft = {
  kind: BioKind;
  slug: string;
  title: string;
  bio: string;
  avatarUrl: string;
  links: BioLinkDraft[];
  socials: BioSocialDraft[];
  release: BioReleaseDraft | null;
  theme: BioThemeDraft;
  published: boolean;
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined || value === null || value === "") return fallback;
  return allowed.includes(value as T) ? (value as T) : null;
}

function idOf(raw: unknown): WithId {
  const id = String(raw ?? "");
  return OBJECT_ID.test(id) ? { _id: new Types.ObjectId(id) } : {};
}

export function randomSlug(length = 6): string {
  return Array.from(randomBytes(length), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

export function normaliseSlug(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug)) return "the short link must be 3–32 letters, numbers or dashes";
  if (RESERVED_SLUGS.has(slug)) return "that short link is reserved, try another";
  return null;
}

export function linkUrl(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 2000) return null;
  if (/^mailto:[^\s]+$/i.test(value) || /^tel:[+0-9 ()-]+$/i.test(value)) return value;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const PHONE = /^\+?[\d\s().-]{6,24}$/;
const TELEGRAM_USERNAME = /^@?([a-z][a-z0-9_]{4,31})$/i;

const CONTACT_PROBLEM: Record<string, string> = {
  whatsapp: "add a WhatsApp number with its country code",
  telegram: "add a Telegram username, number or link",
};

function phoneDigits(value: string): string | null {
  if (!PHONE.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function serviceUrl(service: string, raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  const digits = phoneDigits(value);
  if (service === "whatsapp" && digits) return `https://wa.me/${digits}`;
  if (service === "telegram") {
    if (digits) return `https://t.me/+${digits}`;
    const user = TELEGRAM_USERNAME.exec(value);
    if (user) return `https://t.me/${user[1]}`;
  }
  return linkUrl(value);
}

function socialUrl(network: BioSocialNetwork, value: string): string | null {
  if (network === "email" && !value.startsWith("mailto:")) return linkUrl(`mailto:${value}`);
  return serviceUrl(network, value);
}

function imageUrl(raw: unknown, what: string): string | { error: string } {
  const value = String(raw ?? "").trim();
  if (value && !/^https:\/\//i.test(value)) return { error: `the ${what} must be an https address` };
  return value.slice(0, 2000);
}

function list(raw: unknown, max: number, noun: string): unknown[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${noun} must be a list`;
  if (raw.length > max) return `up to ${max} ${noun}`;
  return raw;
}

function parseLinks(raw: unknown): BioLinkDraft[] | string {
  const items = list(raw, MAX_LINKS, "links");
  if (typeof items === "string") return items;
  const links: BioLinkDraft[] = [];
  for (const item of items) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const label = String(entry.label ?? "").trim().slice(0, 80);
    if (!label) return "every link needs a title";
    const url = linkUrl(entry.url);
    if (!url) return `"${label}" needs a valid web address`;
    links.push({ ...idOf(entry.id), label, url, enabled: entry.enabled === undefined ? true : Boolean(entry.enabled) });
  }
  return links;
}

function parseSocials(raw: unknown): BioSocialDraft[] | string {
  const items = list(raw, MAX_SOCIALS, "social accounts");
  if (typeof items === "string") return items;
  const socials: BioSocialDraft[] = [];
  for (const item of items) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const network = oneOf(entry.network, BIO_SOCIAL_NETWORKS, "website");
    if (!network) return "unknown social network";
    const value = String(entry.url ?? "").trim();
    const url = socialUrl(network, value);
    if (!url) return CONTACT_PROBLEM[network] ?? `the ${network} link needs a valid address`;
    socials.push({ ...idOf(entry.id), network, url, label: String(entry.label ?? "").trim().slice(0, 40) });
  }
  return socials;
}

function parseRows(raw: unknown): BioRowDraft[] | string {
  const items = list(raw, MAX_ROWS, "services");
  if (typeof items === "string") return items;
  if (items.length === 0) return "add at least one service";
  const rows: BioRowDraft[] = [];
  for (const item of items) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const service = String(entry.service ?? "");
    if (!isBioService(service)) return "unknown service";
    const name = String(entry.name ?? "").trim().slice(0, 40);
    if (!name) return "every service needs a name";
    const url = serviceUrl(service, entry.url);
    if (!url) return CONTACT_PROBLEM[service] ?? `add a valid link for ${name}`;
    const action = String(entry.action ?? "").trim().slice(0, 16);
    if (!action) return `add a button label for ${name}`;
    rows.push({ ...idOf(entry.id), service, name, url, action, enabled: entry.enabled === undefined ? true : Boolean(entry.enabled) });
  }
  return rows;
}

function parseRelease(raw: unknown): BioReleaseDraft | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const artworkUrl = imageUrl(r.artworkUrl, "artwork");
  if (typeof artworkUrl !== "string") return artworkUrl.error;
  const releaseDate = String(r.releaseDate ?? "").trim();
  if (releaseDate && !DATE.test(releaseDate)) return "the release date must look like 2026-11-14";
  const rows = parseRows(r.rows);
  if (typeof rows === "string") return rows;
  return { artworkUrl, subtitle: String(r.subtitle ?? "").trim().slice(0, 80), releaseDate, rows };
}

function parseTheme(raw: unknown, kind: BioKind): BioThemeDraft | string {
  const t = (raw ?? {}) as Record<string, unknown>;
  const appearance = oneOf(t.appearance, BIO_APPEARANCES, "light");
  if (!appearance) return "unknown appearance";
  const buttonStyle = oneOf(t.buttonStyle, BIO_BUTTON_STYLES, "rounded");
  if (!buttonStyle) return "unknown button style";
  const background = oneOf(t.background, BIO_BACKGROUNDS, "plain");
  if (!background) return "unknown page colour";
  const font = oneOf(t.font, BIO_FONTS, "sans");
  if (!font) return "unknown font";
  const layouts: readonly BioLayout[] = kind === "release" ? BIO_RELEASE_LAYOUTS : BIO_PROFILE_LAYOUTS;
  const layout = oneOf(t.layout, layouts, layouts[0]) ?? layouts[0];
  const accent = t.accent === undefined ? "#1d1d1f" : String(t.accent);
  if (!HEX.test(accent)) return "the accent colour must be a hex value like #1d1d1f";
  return { appearance, accent: accent.toLowerCase(), buttonStyle, background, layout, font };
}

export function parseBioDraft(body: unknown): BioDraft | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = oneOf(b.kind, BIO_KINDS, "profile");
  if (!kind) return "unknown page type";

  const slug = b.slug === undefined || b.slug === "" ? randomSlug() : normaliseSlug(b.slug);
  const problem = slugProblem(slug);
  if (problem) return problem;

  const title = String(b.title ?? "").trim().slice(0, kind === "release" ? 100 : 80);
  if (!title) return kind === "release" ? "add a title" : "add a page title";

  const avatarUrl = imageUrl(b.avatarUrl, "profile image");
  if (typeof avatarUrl !== "string") return avatarUrl.error;

  const theme = parseTheme(b.theme, kind);
  if (typeof theme === "string") return theme;

  if (kind === "release") {
    const release = parseRelease(b.release);
    if (typeof release === "string") return release;
    return {
      kind,
      slug,
      title,
      bio: "",
      avatarUrl: "",
      links: [],
      socials: [],
      release,
      theme,
      published: b.published === undefined ? true : Boolean(b.published),
    };
  }

  const links = parseLinks(b.links);
  if (typeof links === "string") return links;
  const socials = parseSocials(b.socials);
  if (typeof socials === "string") return socials;

  return {
    kind,
    slug,
    title,
    bio: String(b.bio ?? "").trim().slice(0, 280),
    avatarUrl,
    links,
    socials,
    release: null,
    theme,
    published: b.published === undefined ? true : Boolean(b.published),
  };
}
