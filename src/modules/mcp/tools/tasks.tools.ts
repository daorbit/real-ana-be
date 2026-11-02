import { z } from "zod";
import { nanoid } from "nanoid";
import { LABEL_COLORS, TASK_PRIORITIES, TASK_STATUSES } from "../../tasks/models/Task.js";
import { findTask, searchTasks, taskBoard } from "../../tasks/task-search.service.js";
import { createTask, updateTask } from "../../tasks/task-writes.service.js";
import { ToolError } from "../errors.js";
import { definedOnly, isoDateArg, limitArg, objectIdArg, pageArg, paging } from "../limits.js";
import { presentAssistantTask } from "../work-presenters.js";
import type { ToolContext, ToolDef } from "../tool-runner.js";

const bucketIdArg = objectIdArg("get_task_board");
const memberIdArg = objectIdArg("get_task_board members");
const taskIdArg = objectIdArg("list_tasks");

const taskRefInput = {
  taskId: taskIdArg.optional(),
  key: z.number().int().min(1).optional().describe("The task number shown on the board, e.g. 12 for #12"),
};

const taskFieldsInput = {
  notes: z.string().max(64_000).optional().describe("Description shown on the task card"),
  status: z.enum(TASK_STATUSES).optional().describe("todo, doing or done"),
  priority: z.enum(TASK_PRIORITIES).optional(),
  bucketId: bucketIdArg.optional().describe("Board column from get_task_board; the first column when omitted"),
  assigneeIds: z.array(memberIdArg).max(10).optional().describe("Member ids from get_task_board; replaces the current assignees"),
  startDate: isoDateArg.nullable().optional().describe("Start date, or null to clear it"),
  dueDate: isoDateArg.nullable().optional().describe("Due date, or null to clear it"),
  parentId: taskIdArg.nullable().optional().describe("Make this a subtask of another task, or null to detach it"),
  link: z.string().max(500).optional().describe("A web address or a Quantalog page path starting with /app/"),
  labels: z
    .array(z.object({ text: z.string().min(1).max(24), color: z.enum(LABEL_COLORS).default("gray") }))
    .max(6)
    .optional()
    .describe("Replaces the current labels"),
  checklist: z
    .array(
      z.object({
        id: z.string().max(40).optional().describe("Keep the id from get_task to update an existing item"),
        text: z.string().min(1).max(200),
        done: z.boolean().default(false),
      }),
    )
    .max(30)
    .optional()
    .describe("Replaces the whole checklist"),
};

type TaskFields = z.objectOutputType<typeof taskFieldsInput, z.ZodTypeAny>;

function taskBody(fields: TaskFields & { title?: string }) {
  return definedOnly({
    ...fields,
    checklist: fields.checklist?.map((item) => ({ ...item, id: item.id || nanoid(10) })),
  });
}

async function requireTaskId(ctx: ToolContext, ref: { taskId?: string; key?: number }): Promise<string> {
  if (ref.taskId) return ref.taskId;
  if (ref.key === undefined) throw new ToolError("Pass taskId or key.");
  const task = await findTask(ctx.workspaceId, { key: ref.key });
  if (!task) throw new ToolError(`There is no task #${ref.key} in this workspace.`);
  return task.id;
}

export const getTaskBoardTool: ToolDef<{}> = {
  name: "get_task_board",
  title: "Get task board",
  description:
    "Returns the Tasks board: its columns (buckets) with open task counts, the workspace members tasks can be assigned to (you is marked), and the allowed statuses, priorities and label colours. Call this before creating or assigning tasks.",
  scope: "tasks:read",
  app: "tasks",
  input: {},
  run: async (ctx) => {
    const board = await taskBoard(ctx.workspaceId);
    return {
      buckets: board.buckets,
      members: board.members.map((m) => ({ ...m, you: m.id === ctx.userId })),
      statuses: TASK_STATUSES,
      priorities: TASK_PRIORITIES,
      labelColors: LABEL_COLORS,
    };
  },
};

const listTasksInput = {
  page: pageArg,
  limit: limitArg,
  status: z.enum(["open", "todo", "doing", "done", "all"]).default("open").describe("open means todo and doing"),
  bucketId: bucketIdArg.optional(),
  assigneeId: memberIdArg.optional().describe("Only tasks assigned to this member"),
  priority: z.enum(TASK_PRIORITIES).optional(),
  parentId: taskIdArg.optional().describe("Only subtasks of this task"),
  search: z.string().trim().max(100).optional().describe("Case-insensitive match on the task title"),
  dueBefore: isoDateArg.optional().describe("Only tasks due on or before this date"),
  sort: z.enum(["board", "due", "updated", "created"]).default("board").describe("board keeps the board order"),
};

export const listTasksTool: ToolDef<typeof listTasksInput> = {
  name: "list_tasks",
  title: "List tasks",
  description:
    "Lists tasks in the workspace with status, priority, column, assignees, dates, labels and checklist. Open tasks by default. Notes are shortened; use get_task for the full text. Paginated: use page and limit (max 25).",
  scope: "tasks:read",
  app: "tasks",
  input: listTasksInput,
  run: async (ctx, args) => {
    const result = await searchTasks(ctx.workspaceId, {
      ...args,
      dueBefore: args.dueBefore ? new Date(args.dueBefore) : undefined,
    });
    return {
      tasks: result.tasks.map((t) => presentAssistantTask(t)),
      pagination: paging(args.page, args.limit, result.total),
    };
  },
};

export const getTaskTool: ToolDef<typeof taskRefInput> = {
  name: "get_task",
  title: "Get task",
  description: "Returns one task with its full notes and checklist. Pass taskId from list_tasks, or key for the task number.",
  scope: "tasks:read",
  app: "tasks",
  input: taskRefInput,
  run: async (ctx, args) => {
    if (!args.taskId && args.key === undefined) throw new ToolError("Pass taskId or key.");
    const task = await findTask(ctx.workspaceId, args);
    if (!task) throw new ToolError("That task isn't in this workspace.");
    return presentAssistantTask(task, true);
  },
};

const createTaskInput = {
  title: z.string().trim().min(1).max(200).describe("Short task title"),
  ...taskFieldsInput,
};

export const createTaskTool: ToolDef<typeof createTaskInput> = {
  name: "create_task",
  title: "Create task",
  description:
    "Creates a task on the workspace's Tasks board. Only title is required. Assigned members get a notification. Use get_task_board for column and member ids.",
  scope: "tasks:write",
  app: "tasks",
  minimumRole: "editor",
  writes: "create",
  input: createTaskInput,
  run: async (ctx, args) => presentAssistantTask(await createTask(ctx.workspace, ctx.userId, taskBody(args)), true),
};

const updateTaskInput = {
  ...taskRefInput,
  title: z.string().trim().min(1).max(200).optional(),
  ...taskFieldsInput,
};

export const updateTaskTool: ToolDef<typeof updateTaskInput> = {
  name: "update_task",
  title: "Update task",
  description:
    "Changes a task: pass taskId or key and only the fields to change. Set status to done to complete it. Lists such as assigneeIds, labels and checklist replace the current values, so send the full list.",
  scope: "tasks:write",
  app: "tasks",
  minimumRole: "editor",
  writes: "update",
  input: updateTaskInput,
  run: async (ctx, { taskId, key, ...fields }) => {
    const id = await requireTaskId(ctx, { taskId, key });
    const body = taskBody(fields);
    if (!Object.keys(body).length) throw new ToolError("Pass at least one field to change.");
    return presentAssistantTask(await updateTask(ctx.workspace, ctx.userId, id, body), true);
  },
};
