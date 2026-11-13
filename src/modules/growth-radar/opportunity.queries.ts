import { Types } from "mongoose";
import { ACTIVE_STATUSES, CLOSED_STATUSES, RadarOpportunity } from "./models/RadarOpportunity.js";
import { RadarScan } from "./models/RadarScan.js";
import { CARD_FIELDS, presentCard, presentDetail, presentScan, type OpportunityRow, type ScanRow } from "./present.js";
import { peopleById, peopleIn } from "./people.js";
import { DAY_MS } from "./windows.js";

const FEED_LIMIT = 50;
const HISTORY_PAGE = 30;
const SCAN_LIMIT = 20;
const RESOLVED_WINDOW_DAYS = 30;

const notSnoozed = (now: Date) => ({ $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }] });

export async function radarOverview(workspaceId: string) {
  const now = new Date();
  const [lastScan, active, snoozed, resolved] = await Promise.all([
    RadarScan.findOne({ workspaceId }).sort({ startedAt: -1 }).lean<ScanRow>(),
    RadarOpportunity.find({ workspaceId, status: { $in: ACTIVE_STATUSES }, ...notSnoozed(now) })
      .sort({ priorityRank: -1, lastDetectedAt: -1 })
      .limit(FEED_LIMIT)
      .select(CARD_FIELDS)
      .lean<OpportunityRow[]>(),
    RadarOpportunity.countDocuments({ workspaceId, status: { $in: ACTIVE_STATUSES }, snoozedUntil: { $gt: now } }),
    RadarOpportunity.countDocuments({
      workspaceId,
      status: "resolved",
      closedAt: { $gte: new Date(now.getTime() - RESOLVED_WINDOW_DAYS * DAY_MS) },
    }),
  ]);

  const cards = active.map(presentCard);
  return {
    lastScan: lastScan ? presentScan(lastScan) : null,
    opportunities: cards,
    counts: {
      active: cards.length,
      high: cards.filter((c) => c.priority === "high").length,
      planned: cards.filter((c) => c.status === "planned").length,
      investigating: cards.filter((c) => c.status === "investigating").length,
      snoozed,
      resolved,
    },
  };
}

export async function listOpportunities(workspaceId: string, view: "history" | "snoozed", historyDays: number, before?: Date) {
  const now = new Date();
  if (view === "snoozed") {
    const rows = await RadarOpportunity.find({ workspaceId, status: { $in: ACTIVE_STATUSES }, snoozedUntil: { $gt: now } })
      .sort({ snoozedUntil: 1 })
      .limit(FEED_LIMIT)
      .select(CARD_FIELDS)
      .lean<OpportunityRow[]>();
    return { items: rows.map(presentCard), nextBefore: null };
  }

  const since = new Date(now.getTime() - historyDays * DAY_MS);
  const rows = await RadarOpportunity.find({
    workspaceId,
    status: { $in: CLOSED_STATUSES },
    closedAt: { $gte: since, ...(before ? { $lt: before } : {}) },
  })
    .sort({ closedAt: -1 })
    .limit(HISTORY_PAGE)
    .select(`${CARD_FIELDS} dismissReason`)
    .lean<OpportunityRow[]>();
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({ ...presentCard(r), dismissReason: r.dismissReason ?? "" })),
    nextBefore: rows.length === HISTORY_PAGE && last?.closedAt ? last.closedAt : null,
  };
}

export async function opportunityRow(workspaceId: string, id: string): Promise<OpportunityRow | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return RadarOpportunity.findOne({ _id: id, workspaceId }).lean<OpportunityRow>();
}

export async function opportunityDetail(workspaceId: string, id: string) {
  const row = await opportunityRow(workspaceId, id);
  if (!row) return null;
  return presentDetail(row, await peopleById(peopleIn(row)));
}

export async function scanHistory(workspaceId: string, historyDays: number) {
  const rows = await RadarScan.find({ workspaceId, startedAt: { $gte: new Date(Date.now() - historyDays * DAY_MS) } })
    .sort({ startedAt: -1 })
    .limit(SCAN_LIMIT)
    .lean<ScanRow[]>();
  return rows.map(presentScan);
}
