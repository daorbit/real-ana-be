import { nanoid } from "nanoid";
import { SeoReport } from "./models/SeoReport.js";

const MAX_REPORTS = 300;

type ReportRow = {
  _id: unknown;
  url: string;
  score?: number;
  createdAt: Date;
  shareToken?: string | null;
  shareEnabled?: boolean;
  shareViews?: number;
  shareLastViewedAt?: Date | null;
};

export type SeoShareLink = {
  reportId: string;
  url: string;
  score: number;
  createdAt: Date;
  token: string;
  views: number;
  lastViewedAt: Date | null;
};

export function newSeoShareToken(): string {
  return `pk_seo_${nanoid(32)}`;
}

function groupByUrl(reports: ReportRow[]): Map<string, ReportRow[]> {
  const byUrl = new Map<string, ReportRow[]>();
  for (const r of reports) {
    const runs = byUrl.get(r.url) ?? [];
    runs.push(r);
    byUrl.set(r.url, runs);
  }
  return byUrl;
}

export async function ensureSeoShareLinks(workspaceId: string, siteId: string): Promise<SeoShareLink[]> {
  const reports = await SeoReport.find({ workspaceId, siteId })
    .sort({ createdAt: -1 })
    .limit(MAX_REPORTS)
    .select("url score createdAt shareToken shareEnabled shareViews shareLastViewedAt")
    .lean<ReportRow[]>();

  const ops: Parameters<typeof SeoReport.bulkWrite>[0] = [];
  const links: SeoShareLink[] = [];

  for (const [url, runs] of groupByUrl(reports)) {
    const latest = runs[0];
    let token = latest.shareToken ?? null;
    let views = latest.shareViews ?? 0;
    let lastViewedAt = latest.shareLastViewedAt ?? null;
    const donor = token ? undefined : runs.slice(1).find((r) => r.shareToken);

    for (const old of runs.slice(1)) {
      if (old !== donor && old.shareEnabled) {
        ops.push({ updateOne: { filter: { _id: old._id }, update: { $set: { shareEnabled: false } } } });
      }
    }

    if (!token) {
      if (donor) {
        token = donor.shareToken as string;
        views = donor.shareViews ?? 0;
        lastViewedAt = donor.shareLastViewedAt ?? null;
        ops.push({
          updateOne: {
            filter: { _id: donor._id, shareToken: token },
            update: { $set: { shareToken: null, shareEnabled: false } },
          },
        });
      } else {
        token = newSeoShareToken();
      }
      ops.push({
        updateOne: {
          filter: { _id: latest._id, shareToken: { $in: [null, ""] } },
          update: { $set: { shareToken: token, shareEnabled: true, shareViews: views, shareLastViewedAt: lastViewedAt } },
        },
      });
    } else if (!latest.shareEnabled) {
      ops.push({ updateOne: { filter: { _id: latest._id }, update: { $set: { shareEnabled: true } } } });
    }

    links.push({ reportId: String(latest._id), url, score: latest.score ?? 0, createdAt: latest.createdAt, token, views, lastViewedAt });
  }

  if (!ops.length) return links;
  await SeoReport.bulkWrite(ops, { ordered: true });
  return withStoredTokens(links);
}

async function withStoredTokens(links: SeoShareLink[]): Promise<SeoShareLink[]> {
  const stored = await SeoReport.find({ _id: { $in: links.map((l) => l.reportId) } })
    .select("shareToken shareViews shareLastViewedAt")
    .lean<Pick<ReportRow, "_id" | "shareToken" | "shareViews" | "shareLastViewedAt">[]>();
  const byId = new Map(stored.map((r) => [String(r._id), r]));
  return links.map((link) => {
    const row = byId.get(link.reportId);
    if (!row?.shareToken || row.shareToken === link.token) return link;
    return { ...link, token: row.shareToken, views: row.shareViews ?? 0, lastViewedAt: row.shareLastViewedAt ?? null };
  });
}
