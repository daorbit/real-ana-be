import { BlockedUrlError } from "../../infra/http-client/safe-fetch.js";
import { scanPage, type FoundLink } from "./link-scan.js";
import type { BacklinkStatus } from "./models/Backlink.js";

export type TrackedDomain = { competitorId: string; domain: string };

export type VerifyOutcome = {
  httpStatus: number | null;
  found: FoundLink | null;
  competitorLinks: { competitorId: string; link: FoundLink }[];
  error: string;
};

export async function checkSource(
  sourceUrl: string,
  siteDomain: string,
  competitors: TrackedDomain[]
): Promise<VerifyOutcome> {
  const domains = [siteDomain, ...competitors.map((c) => c.domain).filter((d) => d !== siteDomain)];
  try {
    const scan = await scanPage(sourceUrl, domains);
    return {
      httpStatus: scan.httpStatus,
      found: scan.matches[siteDomain] ?? null,
      competitorLinks: competitors
        .filter((c) => scan.matches[c.domain])
        .map((c) => ({ competitorId: c.competitorId, link: scan.matches[c.domain] })),
      error: scan.httpStatus >= 400 ? `HTTP ${scan.httpStatus}` : "",
    };
  } catch (e) {
    const message = (e as Error)?.message ?? "request failed";
    return {
      httpStatus: null,
      found: null,
      competitorLinks: [],
      error: e instanceof BlockedUrlError ? `blocked: ${message}` : message,
    };
  }
}

type StatusFields = {
  status: BacklinkStatus;
  lastLiveAt: Date | null;
  lostAt: Date | null;
};

export function nextStatus(prev: StatusFields, outcome: VerifyOutcome, now = new Date()): StatusFields {
  const wasLive = Boolean(prev.lastLiveAt);

  if (outcome.found) return { status: "live", lastLiveAt: now, lostAt: null };

  if (outcome.httpStatus === null) {
    return { ...prev, status: wasLive && prev.status === "live" ? "live" : "unreachable" };
  }

  if (outcome.httpStatus >= 400) {
    return { ...prev, status: wasLive ? "page-gone" : "unverified", lostAt: wasLive ? prev.lostAt ?? now : null };
  }

  return wasLive
    ? { ...prev, status: "lost", lostAt: prev.lostAt ?? now }
    : { ...prev, status: "unverified" };
}
