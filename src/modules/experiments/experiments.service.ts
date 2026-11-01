import { currentPlan } from "../billing/quota.service.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { Experiment, type ExperimentStatus } from "./models/Experiment.js";
import type { ExperimentDraft } from "./experiment-draft.js";
import type { ExperimentResultsInput } from "./results.service.js";

type ExperimentDoc = InstanceType<typeof Experiment>;

export type ExperimentView = ExperimentDraft & {
  id: string;
  status: ExperimentStatus;
  winner: string;
  keepWinner: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
};

export function presentExperiment(doc: ExperimentDoc): ExperimentView {
  const o = doc.toObject() as unknown as Record<string, unknown> & ExperimentDraft;
  return {
    id: String(doc._id),
    name: o.name,
    siteId: o.siteId,
    key: o.key,
    type: o.type,
    pages: { mode: o.pages?.mode ?? "all", patterns: o.pages?.patterns ?? [] },
    devices: o.devices ?? "all",
    goal: { type: o.goal?.type ?? "page", value: o.goal?.value ?? "" },
    variants: (o.variants ?? []).map((v) => ({
      key: v.key,
      name: v.name,
      weight: v.weight,
      redirectUrl: v.redirectUrl ?? "",
      changes: (v.changes ?? []).map((c) => ({ selector: c.selector, action: c.action, attr: c.attr ?? "", value: c.value ?? "" })),
    })),
    status: doc.get("status") as ExperimentStatus,
    winner: String(doc.get("winner") ?? ""),
    keepWinner: Boolean(doc.get("keepWinner")),
    startedAt: (doc.get("startedAt") as Date | undefined) ?? null,
    endedAt: (doc.get("endedAt") as Date | undefined) ?? null,
    createdAt: doc.get("createdAt") as Date,
  };
}

export function resultsInput(view: ExperimentView): ExperimentResultsInput {
  return {
    id: view.id,
    siteId: view.siteId,
    goal: view.goal,
    variants: view.variants.map((v) => ({ key: v.key, name: v.name })),
    startedAt: view.startedAt,
    endedAt: view.endedAt,
  };
}

export async function runningLimit(workspaceId: string): Promise<{ limit: number; running: number; plan: string }> {
  const [plan, running] = await Promise.all([
    currentPlan(workspaceId),
    Experiment.countDocuments({ workspaceId, status: "running" }),
  ]);
  const entry = plan ?? getPlanCatalogEntry("free")!;
  return { limit: entry.maxRunningExperiments ?? 1, running, plan: entry.name };
}

export async function listExperiments(workspaceId: string) {
  const [docs, limits] = await Promise.all([
    Experiment.find({ workspaceId }).sort({ createdAt: -1 }).limit(200),
    runningLimit(workspaceId),
  ]);
  return { experiments: docs.map(presentExperiment), ...limits };
}

export async function keyTaken(siteId: string, key: string, exceptId?: string): Promise<boolean> {
  const found = await Experiment.exists({ siteId, key, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  return Boolean(found);
}
