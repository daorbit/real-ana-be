import { Types } from "mongoose";
import { OrbitConversation } from "./models/OrbitConversation.js";
import { OrbitMessage } from "./models/OrbitMessage.js";

/**
 * Saving and reading Orbit conversations for a workspace.
 *
 * Every write here is best-effort. A transcript is a record of something that
 * already happened successfully — the user has their answer on screen — so a
 * database problem must never turn a working answer into a failed request. The
 * recording functions swallow their own errors and log; callers do not await
 * them for correctness and have nothing useful to do if they fail.
 *
 * Reads are the opposite: a list or a transcript that silently comes back empty
 * because of an error looks like deleted data, so those throw normally.
 */

/** Matches the route's own per-turn cap, so stored text is what history carries. */
const MAX_CONTENT_CHARS = 4000;

const MAX_TITLE_CHARS = 160;

/** Follow-ups per answer. The panel renders three; the cap is slack, not policy. */
const MAX_SUGGESTIONS = 8;

const MAX_SUGGESTION_CHARS = 200;

/** One page of the conversation list. */
const LIST_LIMIT = 30;

export type RecordedTurn = {
  reply: string;
  suggestions?: string[];
  model?: string;
  modelLabel?: string;
  latencyMs?: number;
  /** True when `reply` is an error message rather than an answer. */
  failed?: boolean;
};

function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS - 1)}…` : clean;
}

function cleanSuggestions(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.trim().slice(0, MAX_SUGGESTION_CHARS));
}

function asObjectId(raw: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : null;
}

/**
 * Load the conversation a question belongs to, or start a new one.
 *
 * The id comes from the browser, so ownership is re-checked here rather than
 * trusted: a conversation is only continued when it belongs to the workspace
 * the request is scoped to and has not been deleted. Anything else silently
 * starts a new thread — the alternative is failing a question the user is
 * waiting on over a stale id in a tab left open since yesterday.
 */
async function openConversation(
  workspaceId: string,
  userId: string,
  conversationId: string | undefined,
  question: string,
) {
  if (conversationId) {
    const id = asObjectId(conversationId);
    if (id) {
      const existing = await OrbitConversation.findOne({
        _id: id,
        workspaceId,
        deletedAt: null,
      });
      if (existing) return existing;
    }
  }

  return OrbitConversation.create({
    workspaceId,
    userId,
    title: titleFrom(question),
    messageCount: 0,
    lastMessageAt: new Date(),
  });
}

/**
 * Persist one exchange: the question and whatever came back, answer or error.
 *
 * Returns the conversation id so the route can hand it to the browser, which
 * sends it with the next question to continue the thread. Returns null when
 * nothing could be stored — the caller carries on either way, and the browser
 * simply keeps the conversation in memory as it always did.
 */
export async function recordExchange(args: {
  workspaceId: string;
  userId: string;
  conversationId?: string;
  question: string;
  turn: RecordedTurn;
}): Promise<string | null> {
  const { workspaceId, userId, conversationId, question, turn } = args;

  try {
    const convo = await openConversation(workspaceId, userId, conversationId, question);
    const seq = convo.messageCount;

    await OrbitMessage.insertMany([
      {
        conversationId: convo._id,
        workspaceId,
        seq,
        role: "user",
        content: question.slice(0, MAX_CONTENT_CHARS),
      },
      {
        conversationId: convo._id,
        workspaceId,
        seq: seq + 1,
        role: "assistant",
        content: turn.reply.slice(0, MAX_CONTENT_CHARS),
        suggestions: cleanSuggestions(turn.suggestions),
        failed: Boolean(turn.failed),
        model: turn.model ?? "",
        modelLabel: turn.modelLabel ?? "",
        latencyMs: turn.latencyMs ?? 0,
      },
    ]);

    // `$inc` rather than a read-modify-write: two questions sent from two tabs
    // at once would otherwise both write the same count and lose a turn's
    // worth of ordering.
    await OrbitConversation.updateOne(
      { _id: convo._id },
      {
        $inc: { messageCount: 2 },
        $set: {
          lastMessageAt: new Date(),
          lastModel: turn.model ?? "",
          lastModelLabel: turn.modelLabel ?? "",
        },
      },
    );

    return String(convo._id);
  } catch (e) {
    // Logged, not thrown: the answer is already on its way to the user, and a
    // failed write is our problem rather than theirs.
    console.error("[orbit-history] could not record exchange —", e);
    return null;
  }
}

/**
 * A workspace's conversations, most recently active first.
 *
 * Header fields only — this is the sidebar list, and the turns are read when
 * one is opened.
 */
export async function listConversations(workspaceId: string, limit = LIST_LIMIT) {
  const rows = await OrbitConversation.find({ workspaceId, deletedAt: null })
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Math.max(limit, 1), LIST_LIMIT))
    .select("title messageCount lastMessageAt lastModelLabel createdAt userId")
    .lean();

  return rows.map((r) => ({
    id: String(r._id),
    title: r.title,
    messageCount: r.messageCount,
    lastMessageAt: r.lastMessageAt,
    lastModelLabel: r.lastModelLabel,
    createdAt: r.createdAt,
    userId: r.userId ? String(r.userId) : null,
  }));
}

/**
 * One conversation and its turns, in order.
 *
 * Null when it does not exist, belongs to another workspace, or has been
 * deleted — the three are one answer on purpose, so the endpoint cannot be used
 * to learn whether an id is real.
 */
export async function readConversation(workspaceId: string, conversationId: string) {
  const id = asObjectId(conversationId);
  if (!id) return null;

  const convo = await OrbitConversation.findOne({
    _id: id,
    workspaceId,
    deletedAt: null,
  }).lean();
  if (!convo) return null;

  const messages = await OrbitMessage.find({ conversationId: convo._id })
    .sort({ seq: 1 })
    .select("seq role content suggestions failed modelLabel createdAt")
    .lean();

  return {
    id: String(convo._id),
    title: convo.title,
    messageCount: convo.messageCount,
    lastMessageAt: convo.lastMessageAt,
    createdAt: convo.createdAt,
    messages: messages.map((m) => ({
      id: String(m._id),
      seq: m.seq,
      role: m.role as "user" | "assistant",
      content: m.content,
      suggestions: m.suggestions ?? [],
      failed: Boolean(m.failed),
      modelLabel: m.modelLabel || undefined,
      createdAt: m.createdAt,
    })),
  };
}

/**
 * Hide a conversation from the workspace's list.
 *
 * A soft delete: the turns stay for a support question about a bad answer, and
 * the sweep that removes them for real is a separate deliberate job. Returns
 * false when there was nothing to delete.
 */
export async function deleteConversation(workspaceId: string, conversationId: string) {
  const id = asObjectId(conversationId);
  if (!id) return false;

  const result = await OrbitConversation.updateOne(
    { _id: id, workspaceId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

/**
 * Rename a conversation. The title is generated from the first question, which
 * is often not what the thread turned out to be about.
 */
export async function renameConversation(
  workspaceId: string,
  conversationId: string,
  title: string,
) {
  const id = asObjectId(conversationId);
  if (!id) return false;

  const clean = titleFrom(title);
  if (!clean) return false;

  const result = await OrbitConversation.updateOne(
    { _id: id, workspaceId, deletedAt: null },
    { $set: { title: clean } },
  );
  return result.modifiedCount > 0;
}
