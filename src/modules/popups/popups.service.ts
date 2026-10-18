import { Event } from "../analytics/models/Event.js";
import { Site } from "../analytics/models/Site.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { currentPlan } from "../billing/quota.service.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { Popup } from "./models/Popup.js";

const STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type PopupStats = { views: number; submits: number };
type PopupDoc = InstanceType<typeof Popup>;

export type PublicPopup = {
  id: string;
  url: string;
  trigger: { type: string; delaySeconds: number; scrollPercent: number };
  layout: string;
  showAgainDays: number;
  pages: { mode: string; patterns: string[] };
  devices: string;
};

const statsCache = createTtlCache<Record<string, PopupStats>>(60_000);
const publicCache = createTtlCache<PublicPopup[]>(60_000);

export function formsPublicBase(): string {
  return (process.env.FORMS_PUBLIC_URL || process.env.FORMS_API_BASE || "https://forms.daorbit.in").replace(/\/+$/, "");
}

function formUrl(formId: string): string {
  return `${formsPublicBase()}/form/${encodeURIComponent(formId)}/view`;
}

async function popupStats(workspaceId: string, siteIds: string[]): Promise<Record<string, PopupStats>> {
  if (!siteIds.length) return {};
  return statsCache(`${workspaceId}:${siteIds.slice().sort().join(",")}`, async () => {
    const rows = await Event.aggregate<{ _id: { popup: string; name: string }; n: number }>([
      { $match: { siteId: { $in: siteIds }, type: "popup", ts: { $gte: new Date(Date.now() - STATS_DAYS * DAY_MS) } } },
      { $group: { _id: { popup: "$props.popupId", name: "$name" }, n: { $sum: 1 } } },
    ]);
    const stats: Record<string, PopupStats> = {};
    for (const row of rows) {
      const id = String(row._id.popup ?? "");
      if (!id) continue;
      stats[id] ??= { views: 0, submits: 0 };
      if (row._id.name === "view") stats[id].views += row.n;
      if (row._id.name === "submit") stats[id].submits += row.n;
    }
    return stats;
  });
}

export function presentPopup(doc: PopupDoc, stats?: PopupStats) {
  return {
    id: doc.id as string,
    name: doc.get("name") as string,
    siteId: doc.get("siteId") as string,
    formId: doc.get("formId") as string,
    formTitle: doc.get("formTitle") as string,
    enabled: doc.get("enabled") as boolean,
    trigger: {
      type: doc.get("trigger.type") as string,
      delaySeconds: doc.get("trigger.delaySeconds") as number,
      scrollPercent: doc.get("trigger.scrollPercent") as number,
    },
    layout: doc.get("layout") as string,
    showAgainDays: doc.get("showAgainDays") as number,
    pages: { mode: doc.get("pages.mode") as string, patterns: (doc.get("pages.patterns") as string[]) ?? [] },
    devices: doc.get("devices") as string,
    stats: stats ?? { views: 0, submits: 0 },
    createdAt: doc.get("createdAt") as Date,
  };
}

export async function workspacePopups(workspaceId: string) {
  const [popups, sites] = await Promise.all([
    Popup.find({ workspaceId }).sort({ createdAt: 1 }),
    Site.find({ workspaceId }).select("siteId"),
  ]);
  const stats = await popupStats(workspaceId, sites.map((s) => String(s.siteId)));
  return { popups: popups.map((p) => presentPopup(p, stats[p.id])), statsDays: STATS_DAYS };
}

export function publicPopups(siteId: string): Promise<PublicPopup[]> {
  return publicCache(siteId, async () => {
    const site = await Site.findOne({ siteId }).select("workspaceId").lean();
    if (!site) return [];

    const workspaceId = String(site.workspaceId);
    const [workspace, plan, popups] = await Promise.all([
      Workspace.findById(workspaceId).select("apps.popups.enabled").lean<{ apps?: { popups?: { enabled?: boolean } } }>(),
      currentPlan(workspaceId),
      Popup.find({ siteId, enabled: true })
        .sort({ createdAt: 1 })
        .select("formId trigger layout showAgainDays pages devices")
        .lean(),
    ]);
    if (!workspace?.apps?.popups?.enabled) return [];

    const allowed = (plan ?? getPlanCatalogEntry("free")!).maxPopups;
    return popups.slice(0, allowed).map((p) => ({
      id: String(p._id),
      url: formUrl(String(p.formId)),
      trigger: {
        type: String(p.trigger?.type ?? "delay"),
        delaySeconds: Number(p.trigger?.delaySeconds ?? 8),
        scrollPercent: Number(p.trigger?.scrollPercent ?? 50),
      },
      layout: String(p.layout ?? "modal"),
      showAgainDays: Number(p.showAgainDays ?? 7),
      pages: { mode: String(p.pages?.mode ?? "all"), patterns: (p.pages?.patterns as string[] | undefined) ?? [] },
      devices: String(p.devices ?? "all"),
    }));
  });
}
