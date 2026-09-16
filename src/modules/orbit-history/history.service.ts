import { Types } from "mongoose";
import { OrbitConversation } from "./models/OrbitConversation.js";
import { OrbitMessage } from "./models/OrbitMessage.js";


const MAX_CONTENT_CHARS = 4000;

const MAX_TITLE_CHARS = 160;


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
  /** A generated image's Cloudinary URL, on an assistant turn that drew one. */
  imageUrl?: string;
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


export async function recordExchange(args: {
  workspaceId: string;
  userId: string;
  conversationId?: string;
  question: string;
  imageUrl?: string;
  turn: RecordedTurn;
}): Promise<string | null> {
  const { workspaceId, userId, conversationId, question, imageUrl, turn } = args;

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
        imageUrl: imageUrl || undefined,
      },
      {
        conversationId: convo._id,
        workspaceId,
        seq: seq + 1,
        role: "assistant",
        content: turn.reply.slice(0, MAX_CONTENT_CHARS),
        imageUrl: turn.imageUrl || undefined,
        suggestions: cleanSuggestions(turn.suggestions),
        failed: Boolean(turn.failed),
        model: turn.model ?? "",
        modelLabel: turn.modelLabel ?? "",
        latencyMs: turn.latencyMs ?? 0,
      },
    ]);


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

    console.error("[orbit-history] could not record exchange —", e);
    return null;
  }
}


export async function listConversations(
  workspaceId: string,
  opts: { limit?: number; before?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? LIST_LIMIT, 1), LIST_LIMIT);

  const filter: Record<string, unknown> = { workspaceId, deletedAt: null };

  if (opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) {
      filter.lastMessageAt = { $lt: cursor };
    }
  }

  const rows = await OrbitConversation.find(filter)
    .sort({ lastMessageAt: -1 })
    .limit(limit)
    .select("title messageCount lastMessageAt lastModelLabel createdAt userId")
    .lean();

  const conversations = rows.map((r) => ({
    id: String(r._id),
    title: r.title,
    messageCount: r.messageCount,
    lastMessageAt: r.lastMessageAt,
    lastModelLabel: r.lastModelLabel,
    createdAt: r.createdAt,
    userId: r.userId ? String(r.userId) : null,
  }));

  // Fewer rows than asked for means there is nothing further back.
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1].lastMessageAt.toISOString() : null;

  return { conversations, nextCursor };
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
    .select("seq role content imageUrl suggestions failed modelLabel createdAt")
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
      imageUrl: m.imageUrl || undefined,
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

/** Hide several conversations at once. Invalid ids are dropped rather than
 * failing the whole batch — the browser's selection is trusted, not blindly. */
export async function deleteConversations(workspaceId: string, conversationIds: string[]) {
  const ids = conversationIds.map(asObjectId).filter((id): id is Types.ObjectId => id != null);
  if (!ids.length) return 0;

  const result = await OrbitConversation.updateMany(
    { _id: { $in: ids }, workspaceId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  );
  return result.modifiedCount;
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
