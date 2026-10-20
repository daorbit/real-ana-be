import { readFormsWorkspace } from "../../../infra/http-client/forms-service.js";
import { rangeDaysArg, rangeToDays, TOP_N } from "../limits.js";
import type { ToolDef } from "../tool-runner.js";

const DAY_MS = 24 * 60 * 60 * 1000;
function windowFor(range: "7d" | "30d" | "90d" | "365d") {
  const until = new Date();
  const since = new Date(until.getTime() - rangeToDays(range) * DAY_MS);
  return { from: since.toISOString(), to: until.toISOString() };
}

type LeadSources = { sources: { source: string; count: number; won: number }[]; forms: number };

const summaryInput = { range: rangeDaysArg };

export const getLeadSummaryTool: ToolDef<typeof summaryInput> = {
  name: "get_lead_summary",
  title: "Get lead summary",
  description:
    "Summarises leads captured by the workspace's forms over a window: total leads, count per pipeline stage (new, contacted, qualified, won, lost), average lead score, the forms producing the most leads, and which traffic channels leads came from.",
  scope: "submissions:read",
  input: summaryInput,
  run: async (ctx, args) => {
    const window = windowFor(args.range);
    const [pipeline, sources] = await Promise.all([
      readFormsWorkspace<Record<string, unknown>>(ctx.workspaceId, ctx.userId, "/pipeline-summary", window),
      readFormsWorkspace<LeadSources>(ctx.workspaceId, ctx.userId, "/lead-sources", { range: args.range }),
    ]);
    return {
      range: args.range,
      ...pipeline,
      sources: { window: args.range, channels: sources.sources.slice(0, TOP_N) },
    };
  },
};

export const getBookingSummaryTool: ToolDef<typeof summaryInput> = {
  name: "get_booking_summary",
  title: "Get booking summary",
  description:
    "Summarises confirmed bookings made through booking forms: how many slots were booked in the window, the forms they came through, and the next upcoming booked slots (times only, no attendee details).",
  scope: "bookings:read",
  input: summaryInput,
  run: async (ctx, args) => ({
    range: args.range,
    ...(await readFormsWorkspace<Record<string, unknown>>(ctx.workspaceId, ctx.userId, "/booking-summary", windowFor(args.range))),
  }),
};
