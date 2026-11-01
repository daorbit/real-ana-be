import { Site } from "../analytics/models/Site.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { appEnabled } from "../workspace/apps.service.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { Experiment } from "./models/Experiment.js";

export type PublicExperiment = {
  id: string;
  key: string;
  type: string;
  final: boolean;
  pages: { mode: string; patterns: string[] };
  devices: string;
  variants: {
    key: string;
    weight: number;
    redirectUrl: string;
    changes: { selector: string; action: string; attr: string; value: string }[];
  }[];
};

type Row = {
  _id: unknown;
  key: string;
  type: string;
  status: string;
  winner?: string;
  pages?: { mode?: string; patterns?: string[] };
  devices?: string;
  variants?: PublicExperiment["variants"];
};

const cache = createTtlCache<PublicExperiment[]>(60_000);

function toPublic(row: Row): PublicExperiment | null {
  const variants = (row.variants ?? []).map((v) => ({
    key: v.key,
    weight: v.weight,
    redirectUrl: v.redirectUrl ?? "",
    changes: (v.changes ?? []).map((c) => ({ selector: c.selector, action: c.action, attr: c.attr ?? "", value: c.value ?? "" })),
  }));
  const final = row.status === "ended";
  const picked = final ? variants.filter((v) => v.key === row.winner).map((v) => ({ ...v, weight: 100 })) : variants;
  if (!picked.length) return null;
  return {
    id: String(row._id),
    key: row.key,
    type: row.type,
    final,
    pages: { mode: row.pages?.mode ?? "all", patterns: row.pages?.patterns ?? [] },
    devices: row.devices ?? "all",
    variants: picked,
  };
}

export function publicExperiments(siteId: string): Promise<PublicExperiment[]> {
  return cache(siteId, async () => {
    const site = await Site.findOne({ siteId }).select("workspaceId").lean<{ workspaceId: unknown }>();
    if (!site) return [];
    const [workspace, rows] = await Promise.all([
      Workspace.findById(String(site.workspaceId)).select("apps.experiments.enabled apps.experiments.paidAt apps.experiments.enabledAt"),
      Experiment.find({
        siteId,
        $or: [{ status: "running" }, { status: "ended", keepWinner: true, winner: { $ne: "" } }],
      })
        .select("key type status winner pages devices variants")
        .limit(50)
        .lean<Row[]>(),
    ]);
    if (!workspace || !appEnabled(workspace, "experiments")) return [];
    return rows.map(toPublic).filter((e): e is PublicExperiment => Boolean(e));
  });
}
