import { Types } from "mongoose";
import { badRequest, notFound } from "../../shared/errors/index.js";
import { areMembers } from "../tasks/tasks.service.js";
import { RadarOpportunity, type OpportunityStatus } from "./models/RadarOpportunity.js";
import { opportunityDetail, opportunityRow } from "./opportunity.queries.js";
import { DAY_MS } from "./windows.js";

const USER_STATUSES: OpportunityStatus[] = ["open", "planned", "investigating", "resolved", "dismissed"];
const CLOSING: OpportunityStatus[] = ["resolved", "dismissed"];
const MAX_SNOOZE_DAYS = 180;
const MAX_REASON = 300;
const MAX_NOTE = 1000;
const MAX_NOTES = 200;
const MAX_ACTION = 500;
const MAX_BACKDATE_DAYS = 30;
const ACTIVITY_KEPT = 100;

const STATUS_LABEL: Record<OpportunityStatus, string> = {
  open: "open",
  planned: "planned",
  investigating: "under investigation",
  resolved: "resolved",
  dismissed: "dismissed",
  archived: "archived",
};

type Entry = { at: Date; userId: string; kind: string; detail: string };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

async function loadOrThrow(workspaceId: string, id: string) {
  const row = await opportunityRow(workspaceId, id);
  if (!row) throw notFound("Opportunity not found");
  return row;
}

async function detailOrThrow(workspaceId: string, id: string) {
  const detail = await opportunityDetail(workspaceId, id);
  if (!detail) throw notFound("Opportunity not found");
  return detail;
}

export async function updateOpportunity(workspaceId: string, id: string, userId: string, body: unknown) {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const row = await loadOrThrow(workspaceId, id);
  const now = new Date();
  const set: Record<string, unknown> = {};
  const entries: Entry[] = [];

  if (input.status !== undefined) {
    const status = input.status as OpportunityStatus;
    if (!USER_STATUSES.includes(status)) throw badRequest("Unknown status");
    if (status !== row.status) {
      set.status = status;
      set.closedAt = CLOSING.includes(status) ? now : null;
      if (status === "dismissed") set.dismissReason = text(input.dismissReason, MAX_REASON);
      if (CLOSING.includes(status)) set.snoozedUntil = null;
      const reason = status === "dismissed" && set.dismissReason ? `: ${set.dismissReason}` : "";
      entries.push({ at: now, userId, kind: "status", detail: `Marked as ${STATUS_LABEL[status]}${reason}` });
    }
  }

  if (input.snoozedUntil !== undefined) {
    if (input.snoozedUntil === null) {
      if (row.snoozedUntil) {
        set.snoozedUntil = null;
        entries.push({ at: now, userId, kind: "snooze", detail: "Snooze ended" });
      }
    } else {
      const until = dateOf(input.snoozedUntil);
      if (!until || until.getTime() <= now.getTime() || until.getTime() > now.getTime() + MAX_SNOOZE_DAYS * DAY_MS) {
        throw badRequest(`Pick a date in the next ${MAX_SNOOZE_DAYS} days`);
      }
      set.snoozedUntil = until;
      entries.push({ at: now, userId, kind: "snooze", detail: `Snoozed until ${dayLabel(until)}` });
    }
  }

  if (input.assigneeId !== undefined) {
    const assigneeId = input.assigneeId === null || input.assigneeId === "" ? null : String(input.assigneeId);
    if (assigneeId && (!Types.ObjectId.isValid(assigneeId) || !(await areMembers(workspaceId, [assigneeId])))) {
      throw badRequest("The owner must be a member of this workspace");
    }
    if (String(row.assigneeId ?? "") !== String(assigneeId ?? "")) {
      set.assigneeId = assigneeId;
      entries.push({ at: now, userId, kind: "assigned", detail: assigneeId ? "Owner changed" : "Owner removed" });
    }
  }

  if (Object.keys(set).length) {
    await RadarOpportunity.updateOne(
      { _id: row._id, workspaceId },
      { $set: set, ...(entries.length ? { $push: { activity: { $each: entries, $slice: -ACTIVITY_KEPT } } } : {}) },
    );
  }
  return detailOrThrow(workspaceId, id);
}

export async function addNote(workspaceId: string, id: string, userId: string, body: unknown) {
  const note = text((body as Record<string, unknown> | null)?.text, MAX_NOTE);
  if (!note) throw badRequest("Write a note first");
  if (!Types.ObjectId.isValid(id)) throw notFound("Opportunity not found");
  const result = await RadarOpportunity.updateOne(
    { _id: id, workspaceId },
    { $push: { notes: { $each: [{ userId, text: note, at: new Date() }], $slice: -MAX_NOTES } } },
  );
  if (!result.matchedCount) throw notFound("Opportunity not found");
  return detailOrThrow(workspaceId, id);
}

export async function recordAction(workspaceId: string, id: string, userId: string, body: unknown) {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const description = text(input.description, MAX_ACTION);
  if (description.length < 3) throw badRequest("Describe what you changed");

  const now = new Date();
  const startedAt = input.startedAt === undefined ? now : dateOf(input.startedAt);
  if (!startedAt || startedAt.getTime() > now.getTime() + DAY_MS || startedAt.getTime() < now.getTime() - MAX_BACKDATE_DAYS * DAY_MS) {
    throw badRequest(`The start date must be within the last ${MAX_BACKDATE_DAYS} days`);
  }

  const row = await loadOrThrow(workspaceId, id);
  const metric = (row.metrics ?? []).find((m) => m.key === row.primaryMetric);
  if (!metric) throw badRequest("This finding has no metric to follow up");

  const followUpDays = row.period.days;
  const set: Record<string, unknown> = {
    action: {
      description,
      otherChanges: text(input.otherChanges, MAX_ACTION),
      userId,
      startedAt,
      followUpDays,
      followUpEndsAt: new Date(startedAt.getTime() + (followUpDays + 1) * DAY_MS),
      metric: metric.key,
      baseline: metric.current,
    },
  };
  if (row.status === "open") set.status = "planned";

  await RadarOpportunity.updateOne(
    { _id: row._id, workspaceId },
    {
      $set: set,
      $push: { activity: { $each: [{ at: now, userId, kind: "action", detail: description }], $slice: -ACTIVITY_KEPT } },
    },
  );
  return detailOrThrow(workspaceId, id);
}
