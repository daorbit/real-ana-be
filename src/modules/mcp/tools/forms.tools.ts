import { z } from "zod";
import { readFormsWorkspace } from "../../../infra/http-client/forms-service.js";
import { escapeRegex, formIdArg, limitArg, pageArg, paging } from "../limits.js";
import { presentFormDetails, presentFormSummary } from "../presenters.js";
import type { ToolDef } from "../tool-runner.js";

type FormList = {
  items: Record<string, unknown>[];
  total: number;
  stats: Record<string, number>;
};

const listFormsInput = {
  page: pageArg,
  limit: limitArg,
  status: z.enum(["published", "draft"]).optional().describe("Only forms with this status"),
  search: z.string().trim().max(100).optional().describe("Case-insensitive match on the form name"),
  sort: z.enum(["date", "dateAsc", "name", "nameDesc"]).default("date").describe("Newest first by default"),
};

export const listFormsTool: ToolDef<typeof listFormsInput> = {
  name: "list_forms",
  title: "List forms",
  description:
    "Lists lead-capture forms in the workspace with their status, view count and response count, plus workspace-wide totals. Paginated: use page and limit (max 25).",
  scope: "forms:read",
  input: listFormsInput,
  run: async (ctx, args) => {
    const result = await readFormsWorkspace<FormList>(ctx.workspaceId, ctx.userId, "", {
      page: args.page,
      limit: args.limit,
      status: args.status,
      sort: args.sort,
      q: args.search ? escapeRegex(args.search) : undefined,
    });
    return {
      totals: result.stats,
      forms: result.items.map(presentFormSummary),
      pagination: paging(args.page, args.limit, result.total),
    };
  },
};

const formDetailsInput = { formId: formIdArg };

export const getFormDetailsTool: ToolDef<typeof formDetailsInput> = {
  name: "get_form_details",
  title: "Get form details",
  description:
    "Returns one form's questions (id, type, label, required, options) and its analytics: views, responses, completion rate, top lead sources and the last 14 days of activity.",
  scope: "forms:read",
  input: formDetailsInput,
  run: async (ctx, args) => {
    const [form, analytics] = await Promise.all([
      readFormsWorkspace<Record<string, unknown>>(ctx.workspaceId, ctx.userId, `/${args.formId}`),
      readFormsWorkspace<Record<string, unknown>>(ctx.workspaceId, ctx.userId, `/${args.formId}/analytics`).catch(() => null),
    ]);
    return presentFormDetails(form, analytics);
  },
};
