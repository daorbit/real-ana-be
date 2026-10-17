import { Types } from "mongoose";
import { User } from "../identity/models/User.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { Membership } from "../workspace/models/Membership.js";
import { Site } from "../analytics/models/Site.js";
import { Event } from "../analytics/models/Event.js";
import { Subscription } from "../billing/models/Subscription.js";
import { AuditLog } from "../audit/models/AuditLog.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_WORKSPACES = 50;
const MAX_SITES = 300;
const RECENT_SIGN_INS = 6;
const APP_KEYS = ["compare", "goals", "notes", "reviews", "links", "media"] as const;

type WorkspaceRow = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  createdAt: Date;
  apps?: Partial<Record<(typeof APP_KEYS)[number], { enabled?: boolean }>>;
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function planFor(sub: { planSlug?: string; status?: string; currentPeriodEnd?: Date | null } | undefined) {
  if (!sub?.planSlug) return null;
  const entry = getPlanCatalogEntry(sub.planSlug);
  if (!entry) return null;
  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  return {
    slug: entry.slug,
    name: entry.name,
    status: String(sub.status ?? ""),
    expired: end ? end.getTime() < Date.now() : false,
    renewsAt: end,
  };
}

export async function adminUserOverview(userId: string) {
  if (!Types.ObjectId.isValid(userId)) return null;
  const uid = new Types.ObjectId(userId);
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);

  const [user, owned, memberships, signIns] = await Promise.all([
    User.findById(uid).select("email name role avatarUrl createdAt totpEnabled screenLockEnabled").lean(),
    Workspace.find({ userId: uid }).select("userId name createdAt apps").limit(MAX_WORKSPACES).lean<WorkspaceRow[]>(),
    Membership.find({ userId: uid }).select("workspaceId role").limit(MAX_WORKSPACES).lean(),
    AuditLog.find({ actorId: uid, action: "account.login" })
      .sort({ createdAt: -1 })
      .limit(RECENT_SIGN_INS)
      .select("createdAt meta location browser os")
      .lean(),
  ]);
  if (!user) return null;

  const ownedIds = new Set(owned.map((w) => String(w._id)));
  const roleByWorkspace = new Map(memberships.map((m) => [String(m.workspaceId), String(m.role)]));
  const sharedIds = memberships.map((m) => String(m.workspaceId)).filter((id) => !ownedIds.has(id));

  const shared = sharedIds.length
    ? await Workspace.find({ _id: { $in: sharedIds } }).select("userId name createdAt apps").lean<WorkspaceRow[]>()
    : [];
  const workspaces = [...owned, ...shared];
  const workspaceIds = workspaces.map((w) => w._id);
  const ownerIds = [...new Set(shared.map((w) => String(w.userId)))];

  const [sites, memberCounts, subs, owners] = await Promise.all([
    Site.find({ workspaceId: { $in: workspaceIds } })
      .select("workspaceId name domain platform siteId createdAt")
      .limit(MAX_SITES)
      .lean(),
    Membership.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { workspaceId: { $in: workspaceIds } } },
      { $group: { _id: "$workspaceId", n: { $sum: 1 } } },
    ]),
    Subscription.find({ workspaceId: { $in: workspaceIds } })
      .select("workspaceId planSlug status currentPeriodEnd eventsUsed")
      .lean(),
    ownerIds.length ? User.find({ _id: { $in: ownerIds } }).select("name email").lean() : Promise.resolve([]),
  ]);

  const siteIds = sites.map((s) => String(s.siteId));
  const [perSite, perDay] = siteIds.length
    ? await Promise.all([
        Event.aggregate<{ _id: string; n: number; last: Date }>([
          { $match: { siteId: { $in: siteIds }, ts: { $gte: since } } },
          { $group: { _id: "$siteId", n: { $sum: 1 }, last: { $max: "$ts" } } },
        ]),
        Event.aggregate<{ _id: string; n: number }>([
          { $match: { siteId: { $in: siteIds }, ts: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } }, n: { $sum: 1 } } },
        ]),
      ])
    : [[], []];

  const eventsBySite = new Map(perSite.map((row) => [row._id, row]));
  const membersByWorkspace = new Map(memberCounts.map((row) => [String(row._id), row.n]));
  const subByWorkspace = new Map(subs.map((s) => [String(s.workspaceId), s]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));
  const dayCounts = new Map(perDay.map((row) => [row._id, row.n]));

  const trend = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const date = new Date(Date.now() - (WINDOW_DAYS - 1 - i) * DAY_MS);
    const key = dayKey(date);
    return { date: key, events: dayCounts.get(key) ?? 0 };
  });

  const workspaceViews = workspaces.map((ws) => {
    const id = String(ws._id);
    const isOwner = ownedIds.has(id);
    const owner = isOwner ? null : ownerById.get(String(ws.userId));
    const wsSites = sites
      .filter((s) => String(s.workspaceId) === id)
      .map((s) => {
        const events = eventsBySite.get(String(s.siteId));
        return {
          id: String(s._id),
          name: String(s.name ?? ""),
          domain: String(s.domain ?? ""),
          platform: String(s.platform ?? "web"),
          createdAt: s.createdAt,
          events30d: events?.n ?? 0,
          lastEventAt: events?.last ?? null,
        };
      })
      .sort((a, b) => b.events30d - a.events30d);

    return {
      id,
      name: ws.name,
      createdAt: ws.createdAt,
      role: isOwner ? "owner" : roleByWorkspace.get(id) ?? "viewer",
      owner: owner ? { name: String(owner.name ?? ""), email: String(owner.email ?? "") } : null,
      members: membersByWorkspace.get(id) ?? (isOwner ? 1 : 0),
      plan: planFor(subByWorkspace.get(id)),
      apps: APP_KEYS.filter((key) => ws.apps?.[key]?.enabled),
      events30d: wsSites.reduce((sum, s) => sum + s.events30d, 0),
      sites: wsSites,
    };
  });

  const ownedPlans = workspaceViews.filter((w) => w.role === "owner" && w.plan).map((w) => w.plan!);
  const accountPlan = ownedPlans.find((p) => !p.expired) ?? ownedPlans[0] ?? null;
  const lastEventAt = perSite.reduce<Date | null>((latest, row) => (!latest || row.last > latest ? row.last : latest), null);

  return {
    user: {
      id: String(user._id),
      email: String(user.email ?? ""),
      name: String(user.name ?? ""),
      role: String(user.role ?? "user"),
      avatarUrl: String(user.avatarUrl ?? ""),
      createdAt: user.createdAt,
      totpEnabled: Boolean(user.totpEnabled),
      screenLockEnabled: Boolean(user.screenLockEnabled),
      plan: accountPlan ? { slug: accountPlan.slug, name: accountPlan.name, expired: accountPlan.expired } : null,
      lastEventAt,
    },
    totals: {
      workspaces: workspaceViews.length,
      owned: owned.length,
      shared: shared.length,
      sites: sites.length,
      events30d: trend.reduce((sum, d) => sum + d.events, 0),
    },
    trend,
    workspaces: workspaceViews,
    signIns: signIns.map((entry) => ({
      at: entry.createdAt,
      method: String((entry.meta as { method?: string } | undefined)?.method ?? ""),
      location: String(entry.location ?? ""),
      browser: String(entry.browser ?? ""),
      os: String(entry.os ?? ""),
    })),
  };
}
