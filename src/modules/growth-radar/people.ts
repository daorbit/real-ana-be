import { Types } from "mongoose";
import { User } from "../identity/models/User.js";
import type { OpportunityRow, Person } from "./present.js";

export function peopleIn(row: OpportunityRow): string[] {
  const ids = [
    row.assigneeId,
    row.action?.userId,
    ...(row.notes ?? []).map((n) => n.userId),
    ...(row.activity ?? []).map((a) => a.userId),
  ];
  return [...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map(String))];
}

export async function peopleById(ids: string[]): Promise<Map<string, Person>> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (!valid.length) return new Map();
  const users = await User.find({ _id: { $in: valid } })
    .select("name avatarUrl")
    .lean<{ _id: Types.ObjectId; name?: string; avatarUrl?: string }[]>();
  return new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.name ?? "", avatarUrl: u.avatarUrl ?? "" }]));
}
