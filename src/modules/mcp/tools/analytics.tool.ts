import { z } from "zod";
import { Site } from "../../analytics/models/Site.js";
import { computeStats, resolveWindow } from "../../analytics/stats.service.js";
import { canUseRange } from "../../billing/quota.service.js";
import { createTtlCache } from "../../../shared/utils/ttl-cache.js";
import { ToolError } from "../errors.js";
import { topRows } from "../presenters.js";
import type { ToolDef } from "../tool-runner.js";

const MAX_SITES = 50;
const statsCache = createTtlCache<Awaited<ReturnType<typeof computeStats>>>(30_000, 200);

const analyticsInput = {
  range: z.enum(["24h", "7d", "30d"]).default("7d").describe("Reporting window"),
  siteId: z.string().trim().max(64).optional().describe("Limit to one site (siteId from get_workspace). Defaults to every site."),
};

export const getAnalyticsSummaryTool: ToolDef<typeof analyticsInput> = {
  name: "get_analytics_summary",
  title: "Get website analytics summary",
  description:
    "Summarises website traffic for the workspace's tracked sites: visitors, pageviews, sessions and bounce rate with change versus the previous period, visitors online now, and the top pages, referrers, countries and devices.",
  scope: "analytics:read",
  input: analyticsInput,
  run: async (ctx, args) => {
    const [sites, allowed] = await Promise.all([
      Site.find({ workspaceId: ctx.workspaceId }).select("siteId name domain").limit(MAX_SITES).lean(),
      canUseRange(ctx.workspaceId, args.range),
    ]);

    const scoped = args.siteId ? sites.filter((s) => s.siteId === args.siteId) : sites;
    if (args.siteId && !scoped.length) throw new ToolError("No site with that siteId in this workspace. Call get_workspace for the list.");
    if (!scoped.length) return { range: args.range, sites: [], note: "This workspace has no tracked sites yet." };
    if (!allowed.ok) throw new ToolError(allowed.error);

    const ids = scoped.map((s) => s.siteId as string).sort();
    const stats = await statsCache(`${ctx.workspaceId}:${ids.join(",")}:${args.range}`, () =>
      computeStats(ids, args.range, undefined, resolveWindow(args.range)),
    );

    return {
      range: args.range,
      sites: scoped.map((s) => ({ siteId: s.siteId, name: s.name, domain: s.domain })),
      visitors: stats.visitors,
      pageviews: stats.pageviews,
      sessions: stats.sessions,
      bounceRatePct: stats.bounceRate,
      changeVsPreviousPct: stats.deltas ?? null,
      onlineNow: stats.live,
      topPages: topRows(stats.topPages),
      topReferrers: topRows(stats.topReferrers),
      countries: topRows(stats.countries),
      devices: topRows(stats.devices),
    };
  },
};
