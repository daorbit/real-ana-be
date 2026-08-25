import crypto from "crypto";
import { UAParser } from "ua-parser-js";
import { Request } from "express";

// Anonymous visitor hash: ip + ua + siteId + weekly salt.
// Rotates each ISO week so it can't be used as a persistent identifier
// (privacy-friendly), while giving a wider unique-visitor window than a
// daily salt — a visitor returning within the same week still counts once.
function isoWeekKey(d: Date): string {
  // Copy, normalize to the Thursday of this ISO week, then read that year.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1 ... Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function visitorHash(ip: string, ua: string, siteId: string): string {
  const week = isoWeekKey(new Date());
  return crypto
    .createHash("sha256")
    .update(`${ip}|${ua}|${siteId}|${week}`)
    .digest("hex")
    .slice(0, 32);
}

export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "0.0.0.0";
}

// Vercel injects geo headers on the edge; fall back to unknown locally.
export function country(req: Request): string {
  const c = req.headers["x-vercel-ip-country"];
  return typeof c === "string" && c ? c : "unknown";
}

export function parseUA(ua: string) {
  const p = new UAParser(ua).getResult();
  const type = p.device.type; // undefined for desktop
  return {
    device: type ?? "desktop", // mobile | tablet | desktop
    os: p.os.name ?? "unknown",
    browser: p.browser.name ?? "unknown",
  };
}
