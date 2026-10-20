import { z } from "zod";
import { readFormsWorkspace } from "../../../infra/http-client/forms-service.js";
import { ToolError } from "../errors.js";
import { formIdArg, isoDateArg, limitArg, pageArg, paging } from "../limits.js";
import { flattenFields, presentSubmission } from "../presenters.js";
import type { ToolDef } from "../tool-runner.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type SubmissionPage ={ items: Record<string, unknown>[]; total: number };
type FormDoc = { fields?: Parameters<typeof flattenFields>[0] };

const listSubmissionsInput = {
  formId: formIdArg,
  page: pageArg,
  limit: limitArg,
  from: isoDateArg.optional().describe("Only responses submitted on or after this date"),
  to: isoDateArg.optional().describe("Only responses submitted on or before this date"),
  stage: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional().describe("Lead pipeline stage"),
  minScore: z.number().min(0).max(1000).optional().describe("Only leads with at least this lead score"),
  search: z.string().trim().max(100).optional().describe("Text that must appear in one of the answers"),
  sort: z.enum(["newest", "oldest", "score"]).default("newest"),
};

export const listSubmissionsTool: ToolDef<typeof listSubmissionsInput> = {
  name: "list_submissions",
  title: "List form responses",
  description:
    "Lists completed responses to one form, newest first, with each answer labelled by its question, plus pipeline stage, lead score, tags and traffic source. File uploads and signatures are summarised, not returned. Paginated: use page and limit (max 25).",
  scope: "submissions:read",
  input: listSubmissionsInput,
  run: async (ctx, args) => {
    const to = args.to && DATE_ONLY.test(args.to) ? `${args.to}T23:59:59.999Z` : args.to;
    if (args.from && to && Date.parse(args.from) > Date.parse(to)) {
      throw new ToolError("from must be earlier than to");
    }

    const [form, page] = await Promise.all([
      readFormsWorkspace<FormDoc>(ctx.workspaceId, ctx.userId, `/${args.formId}`),
      readFormsWorkspace<SubmissionPage>(ctx.workspaceId, ctx.userId, `/${args.formId}/submissions`, {
        page: args.page,
        limit: args.limit,
        from: args.from,
        to,
        stage: args.stage,
        minScore: args.minScore,
        q: args.search,
        sort: args.sort,
      }),
    ]);

    const fieldsById = new Map(flattenFields(form.fields ?? []).map((f) => [f.id, f]));
    return {
      formId: args.formId,
      responses: page.items.map((s) => presentSubmission(s, fieldsById)),
      pagination: paging(args.page, args.limit, page.total),
    };
  },
};
