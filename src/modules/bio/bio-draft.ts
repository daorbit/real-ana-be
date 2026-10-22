import { Types } from "mongoose";
import {
  BIO_APPEARANCES,
  BIO_BUTTON_STYLES,
  BIO_SOCIAL_NETWORKS,
  type BioAppearance,
  type BioButtonStyle,
  type BioSocialNetwork,
} from "./models/BioPage.js";

const MAX_LINKS = 30;
const MAX_SOCIALS = 9;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const HEX = /^#[0-9a-f]{6}$/i;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "apps", "bio", "docs", "help", "login", "logout", "new", "quantalog",
  "settings", "share", "signup", "support", "www",
]);

export type BioLinkDraft = { _id?: Types.ObjectId; label: string; url: string; enabled: boolean };
export type BioSocialDraft = { network: BioSocialNetwork; url: string };

export type BioDraft = {
  slug: string;
  title: string;
  bio: string;
  avatarUrl: string;
  links: BioLinkDraft[];
  socials: BioSocialDraft[];
  theme: { appearance: BioAppearance; accent: string; buttonStyle: BioButtonStyle };
  published: boolean;
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined) return fallback;
  return allowed.includes(value as T) ? (value as T) : null;
}

export function normaliseSlug(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug)) return "the page address must be 3–32 letters, numbers or dashes";
  if (RESERVED_SLUGS.has(slug)) return "that page address is reserved, try another";
  return null;
}

function linkUrl(raw: unknown): string | null {
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

function parseLinks(raw: unknown): BioLinkDraft[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "links must be a list";
  if (raw.length > MAX_LINKS) return `up to ${MAX_LINKS} links`;
  const links: BioLinkDraft[] = [];
  for (const item of raw) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const label = String(entry.label ?? "").trim().slice(0, 80);
    if (!label) return "every link needs a title";
    const url = linkUrl(entry.url);
    if (!url) return `"${label}" needs a valid web address`;
    const id = String(entry.id ?? "");
    links.push({
      ...(OBJECT_ID.test(id) ? { _id: new Types.ObjectId(id) } : {}),
      label,
      url,
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
    });
  }
  return links;
}

function parseSocials(raw: unknown): BioSocialDraft[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "social links must be a list";
  if (raw.length > MAX_SOCIALS) return `up to ${MAX_SOCIALS} social links`;
  const socials: BioSocialDraft[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const network = oneOf(entry.network, BIO_SOCIAL_NETWORKS, "website");
    if (!network || seen.has(network)) return "each social network can be added once";
    const value = String(entry.url ?? "").trim();
    const url = network === "email" && !value.startsWith("mailto:") ? linkUrl(`mailto:${value}`) : linkUrl(value);
    if (!url) return `the ${network} link needs a valid address`;
    seen.add(network);
    socials.push({ network, url });
  }
  return socials;
}

export function parseBioDraft(body: unknown): BioDraft | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const theme = (b.theme ?? {}) as Record<string, unknown>;

  const slug = normaliseSlug(b.slug);
  const problem = slugProblem(slug);
  if (problem) return problem;

  const title = String(b.title ?? "").trim().slice(0, 80);
  if (!title) return "add a page title";

  const avatarUrl = String(b.avatarUrl ?? "").trim();
  if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return "the profile image must be an https address";

  const links = parseLinks(b.links);
  if (typeof links === "string") return links;
  const socials = parseSocials(b.socials);
  if (typeof socials === "string") return socials;

  const appearance = oneOf(theme.appearance, BIO_APPEARANCES, "light");
  if (!appearance) return "unknown appearance";
  const buttonStyle = oneOf(theme.buttonStyle, BIO_BUTTON_STYLES, "rounded");
  if (!buttonStyle) return "unknown button style";
  const accent = theme.accent === undefined ? "#2f6bff" : String(theme.accent);
  if (!HEX.test(accent)) return "the accent colour must be a hex value like #2f6bff";

  return {
    slug,
    title,
    bio: String(b.bio ?? "").trim().slice(0, 280),
    avatarUrl: avatarUrl.slice(0, 2000),
    links,
    socials,
    theme: { appearance, accent: accent.toLowerCase(), buttonStyle },
    published: b.published === undefined ? true : Boolean(b.published),
  };
}
