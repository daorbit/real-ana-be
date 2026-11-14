import type { Request } from "express";
import { classifyRequest } from "../analytics/bot-detect.js";
import { country, parseUA } from "../analytics/enrich.js";
import { overIngestBurst } from "../analytics/ingest-guard.js";
import { BIO_STAT_RETENTION_MS, BioStat } from "./models/BioStat.js";
import { encodeKey } from "./bio-keys.js";
import { trackedIds } from "./bio-present.js";
import { cachedBioPage, dayKey } from "./bio.service.js";

const SOURCES = new Set(["instagram", "tiktok", "youtube", "x", "facebook", "linkedin", "whatsapp", "email", "qr", "direct", "other"]);
const MAX_BODY = 1024;

export type BioHit = { type: "view" | "click"; source: string; linkId: string; newVisitor: boolean; referrer: string; campaign: string };

function clip(value: unknown, pattern: RegExp, max: number): string {
  return String(value ?? "").toLowerCase().replace(pattern, "").slice(0, max);
}

export function parseHit(body: unknown): BioHit | null {
  let raw: Record<string, unknown> | null = null;
  if (typeof body === "string" && body.length <= MAX_BODY) {
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (body && typeof body === "object") {
    raw = body as Record<string, unknown>;
  }
  if (!raw || (raw.t !== "view" && raw.t !== "click")) return null;
  const source = clip(raw.s, /[^a-z]/g, 20);
  return {
    type: raw.t,
    source: SOURCES.has(source) ? source : "other",
    linkId: clip(raw.l, /[^a-f0-9]/g, 24),
    newVisitor: raw.n === 1 || raw.n === true,
    referrer: clip(raw.r, /[^a-z0-9.-]/g, 100).replace(/^www\./, ""),
    campaign: clip(raw.c, /[^a-z0-9_-]/g, 60),
  };
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function cityOf(req: Request): string {
  const raw = header(req, "x-vercel-ip-city");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).slice(0, 60);
  } catch {
    return "";
  }
}

function browserOf(ua: string, parsed: string): string {
  if (/Instagram/i.test(ua)) return "Instagram in-app";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook in-app";
  if (/LinkedInApp/i.test(ua)) return "LinkedIn in-app";
  return parsed === "unknown" ? "Other" : parsed.slice(0, 40);
}

function deviceOf(type: string): string {
  return type === "mobile" || type === "tablet" ? type : "desktop";
}

function languageOf(req: Request): string {
  const first = header(req, "accept-language").split(",")[0]?.split(";")[0]?.trim() ?? "";
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})?$/.test(first) ? first : "";
}

function viewIncrements(req: Request, hit: BioHit, ua: string): Record<string, number> {
  const parsed = parseUA(ua);
  const place = country(req);
  const city = cityOf(req);
  const inc: Record<string, number> = {
    views: 1,
    [`sources.${hit.source}`]: 1,
    [`devices.${deviceOf(parsed.device)}`]: 1,
    [`browsers.${encodeKey(browserOf(ua, parsed.browser))}`]: 1,
    [`os.${encodeKey(parsed.os === "unknown" ? "Other" : parsed.os)}`]: 1,
    [`hours.${new Date().getUTCHours()}`]: 1,
  };
  if (hit.newVisitor) inc.visitors = 1;
  if (hit.referrer) inc[`referrers.${encodeKey(hit.referrer)}`] = 1;
  if (hit.campaign) inc[`campaigns.${hit.campaign}`] = 1;
  if (place !== "unknown") inc[`countries.${place}`] = 1;
  if (place !== "unknown" && city) inc[`cities.${encodeKey(`${place}:${city}`)}`] = 1;
  const language = languageOf(req);
  if (language) inc[`languages.${encodeKey(language)}`] = 1;
  return inc;
}

export async function recordBioHit(slug: string, hit: BioHit, req: Request): Promise<void> {
  const ua = header(req, "user-agent");
  if (classifyRequest(ua, req.headers) !== null || overIngestBurst(req, `bio:${slug}`)) return;
  const cached = await cachedBioPage(slug);
  if (!cached) return;

  let inc: Record<string, number>;
  if (hit.type === "view") {
    inc = viewIncrements(req, hit, ua);
  } else {
    if (!trackedIds(cached.page).has(hit.linkId)) return;
    inc = { [`clicks.${hit.linkId}`]: 1 };
  }

  const now = new Date();
  await BioStat.updateOne(
    { pageId: cached.page.id, day: dayKey(now) },
    { $inc: inc, $setOnInsert: { workspaceId: cached.workspaceId, expiresAt: new Date(now.getTime() + BIO_STAT_RETENTION_MS) } },
    { upsert: true },
  );
}
