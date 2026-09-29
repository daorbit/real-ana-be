import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import type { Request } from "express";

export type SessionInfo = {
  userAgent: string;
  browser: string;
  os: string;
  device: string;
  ip: string;
  location: string;
};

function clientIp(req: Request): string {
  const raw = req.ip ?? req.socket.remoteAddress ?? "";
  return raw.replace(/^::ffff:/, "") || "unknown";
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string): string {
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function locationFor(ip: string): string {
  const geo = geoip.lookup(ip);
  if (!geo?.country) return "";
  return [geo.city, countryName(geo.country)].filter(Boolean).join(", ");
}

export function sessionInfoFor(req: Request): SessionInfo {
  const userAgent = req.headers["user-agent"] ?? "";
  const { browser, os, device } = new UAParser(userAgent).getResult();
  const ip = clientIp(req);

  return {
    userAgent,
    browser: browser.name ?? "",
    os: os.name ?? "",
    device: device.type ?? "desktop",
    ip,
    location: locationFor(ip),
  };
}
