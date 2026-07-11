import crypto from "crypto";
import { UAParser } from "ua-parser-js";
import { Request } from "express";

// Anonymous visitor hash: ip + ua + siteId + daily salt.
// Rotates each day so it can't be used as a persistent identifier (privacy-friendly).
export function visitorHash(ip: string, ua: string, siteId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash("sha256")
    .update(`${ip}|${ua}|${siteId}|${day}`)
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
