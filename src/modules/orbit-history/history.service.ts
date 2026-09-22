import { Types } from "mongoose";
import { OrbitConversation } from "./models/OrbitConversation.js";
import { OrbitMessage } from "./models/OrbitMessage.js";


const MAX_CONTENT_CHARS = 4000;

const MAX_TITLE_CHARS = 160;


const MAX_SUGGESTIONS = 8;

const MAX_SUGGESTION_CHARS = 200;

/** One page of the conversation list. */
const LIST_LIMIT = 30;

/** One page of a single conversation's messages. */
const MESSAGE_PAGE_LIMIT = 20;

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
  /** The analytics snapshot this answer was based on, when it pulled one. */
  dataDigest?: unknown;
  /** Pages a web search drew on, when the model used one. */
  citations?: { url: string; title: string }[];
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
        dataDigest: turn.dataDigest ?? undefined,
        citations: turn.citations?.length ? turn.citations : undefined,
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


export async function readConversation(
  workspaceId: string,
  conversationId: string,
  opts: { limit?: number; before?: number } = {},
) {
  const id = asObjectId(conversationId);
  if (!id) return null;

  const convo = await OrbitConversation.findOne({
    _id: id,
    workspaceId,
    deletedAt: null,
  }).lean();
  if (!convo) return null;

  const limit = Math.min(Math.max(opts.limit ?? MESSAGE_PAGE_LIMIT, 1), MESSAGE_PAGE_LIMIT);

  const filter: Record<string, unknown> = { conversationId: convo._id };
  if (typeof opts.before === "number") {
    filter.seq = { $lt: opts.before };
  }

  const rows = await OrbitMessage.find(filter)
    .sort({ seq: -1 })
    .limit(limit)
    .select("seq role content imageUrl suggestions dataDigest citations failed modelLabel createdAt")
    .lean();

  const nextBefore = rows.length === limit ? rows[rows.length - 1].seq : null;
  const messages = [...rows].reverse();

  return {
    id: String(convo._id),
    title: convo.title,
    messageCount: convo.messageCount,
    lastMessageAt: convo.lastMessageAt,
    createdAt: convo.createdAt,
    hasMore: nextBefore != null,
    nextBefore,
    messages: messages.map((m) => ({
      id: String(m._id),
      seq: m.seq,
      role: m.role as "user" | "assistant",
      content: m.content,
      imageUrl: m.imageUrl || undefined,
      suggestions: m.suggestions ?? [],
      dataDigest: m.dataDigest ?? undefined,
      citations: m.citations ?? undefined,
      failed: Boolean(m.failed),
      modelLabel: m.modelLabel || undefined,
      createdAt: m.createdAt,
    })),
  };
}


export async function deleteConversation(workspaceId: string, conversationId: string) {
  const id = asObjectId(conversationId);
  if (!id) return false;

  const result = await OrbitConversation.updateOne(
    { _id: id, workspaceId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}


export async function deleteConversations(workspaceId: string, conversationIds: string[]) {
  const ids = conversationIds.map(asObjectId).filter((id): id is Types.ObjectId => id != null);
  if (!ids.length) return 0;

  const result = await OrbitConversation.updateMany(
    { _id: { $in: ids }, workspaceId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
  );
  return result.modifiedCount;
}


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
