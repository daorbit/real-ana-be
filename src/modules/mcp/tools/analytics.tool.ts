import { z } from "zod";
import { Site } from "../../analytics/models/Site.js";
import { computeStats, resolveWindow } from "../../analytics/stats.service.js";
import { canUseRange } from "../../billing/quota.service.js";
import { createTtlCache } from "../../../shared/utils/ttl-cache.js";
import { ToolError } from "../errors.js";
import { presentTraffic } from "../presenters.js";
import type { ToolDef } from "../tool-runner.js";

const MAX_SITES = 50;
const statsCache = createTtlCache<ReturnType<typeof presentTraffic>>(30_000, 200);

const analyticsInput = {
  range: z.enum(["24h", "7d", "30d"]).default("7d").describe("Reporting window"),
  siteId: z.string().trim().max(64).optional().describe("Limit to one site (siteId from get_workspace). Defaults to every site."),
};

export const getAnalyticsSummaryTool: ToolDef<typeof analyticsInput> = {
  name: "get_analytics_summary",
  title: "Get website analytics summary",
  description:
    "Summarises website traffic for the workspace's tracked sites over the window: visitors, pageviews, sessions, bounce rate, average session time and pages per session, the same figures for the previous period with percentage change (null when the previous period had no traffic), visitors online now, an hourly (24h) or daily trend, and top pages, entry pages, referrers, marketing channels, UTM sources, countries, devices and browsers. Each list's name says what it counts.",
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
    const traffic = await statsCache(`${ctx.workspaceId}:${ids.join(",")}:${args.range}`, async () => {
      const win = resolveWindow(args.range);
      const stats = await computeStats(ids, args.range, undefined, win);
      return presentTraffic(stats, win, args.range === "24h");
    });

    return {
      range: args.range,
      sites: scoped.map((s) => ({ siteId: s.siteId, name: s.name, domain: s.domain })),
      ...traffic,
    };
  },
};
