import { AlertSettings } from "./models/AlertSettings.js";
import { AlertEvent } from "./models/AlertEvent.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { Site } from "../analytics/models/Site.js";
import { workspacePlans } from "../billing/quota.service.js";
import { mailConfigured } from "../../infra/mail/mailer.js";
import { pooled } from "../../infra/http-client/safe-fetch.js";
import { telegramSummary } from "../telegram/telegram.service.js";
import { whatsappStatus } from "../whatsapp/whatsapp.service.js";
import { ALERT_CHANNELS, ALERT_RULES, defaultConfig, parseConfig, type AlertConfig } from "./rules.js";
import { evaluateAlerts, type AlertCondition, type AlertSite } from "./checks.js";
import { deliverAlerts, type DeliveryReport } from "./deliver.js";

const HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 25;
const CONCURRENCY = 5;
const CLAIM_MS = 15 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const HISTORY_LIMIT = 20;

type StoredRule = { enabled?: boolean; value?: number };
type SettingsLean = {
  _id: unknown;
  workspaceId: unknown;
  rules?: Partial<Record<string, StoredRule>>;
  channels?: Partial<Record<string, boolean>>;
  active?: Record<string, Date>;
  nextCheckAt?: Date | null;
  lastCheckedAt?: Date | null;
};

function configOf(doc: SettingsLean): AlertConfig {
  const config = defaultConfig();
  for (const rule of ALERT_RULES) {
    const stored = doc.rules?.[rule];
    config.rules[rule] = {
      enabled: stored?.enabled ?? config.rules[rule].enabled,
      value: stored?.value ?? config.rules[rule].value,
    };
  }
  for (const channel of ALERT_CHANNELS) {
    config.channels[channel] = doc.channels?.[channel] ?? config.channels[channel];
  }
  return config;
}

function stateKey(key: string): string {
  return key.replace(/[.$]/g, "_");
}

async function loadSettings(workspaceId: string): Promise<SettingsLean> {
  const doc = await AlertSettings.findOneAndUpdate(
    { workspaceId },
    { $setOnInsert: { nextCheckAt: new Date() } },
    { upsert: true, new: true },
  ).lean<SettingsLean>();
  return doc!;
}

export async function scheduleAlertChecks(workspaceId: string, enabled: boolean): Promise<void> {
  await AlertSettings.updateOne(
    { workspaceId },
    enabled ? { $set: { nextCheckAt: new Date() } } : { $set: { nextCheckAt: null, active: {} } },
    { upsert: true },
  );
}

export async function alertsOverview(workspaceId: string, checkEveryHours: number) {
  const [doc, history, telegram, whatsapp] = await Promise.all([
    loadSettings(workspaceId),
    AlertEvent.find({ workspaceId })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .select("rule title summary link siteId createdAt")
      .lean(),
    telegramSummary(workspaceId),
    whatsappStatus(workspaceId),
  ]);

  return {
    config: configOf(doc),
    checkEveryHours,
    lastCheckedAt: doc.lastCheckedAt ?? null,
    nextCheckAt: doc.nextCheckAt ?? null,
    ongoing: Object.keys(doc.active ?? {}).length,
    history: history.map((h) => ({
      id: String(h._id),
      rule: h.rule,
      title: h.title,
      summary: h.summary,
      link: h.link,
      createdAt: h.createdAt,
    })),
    channels: {
      email: { available: mailConfigured() },
      telegram: { available: telegram.connected && telegram.chats > 0, chats: telegram.chats },
      whatsapp: {
        available: whatsapp.available && whatsapp.entitled && whatsapp.enabled && whatsapp.numbers.length > 0,
        entitled: whatsapp.entitled,
        numbers: whatsapp.numbers.length,
      },
    },
  };
}

export async function currentAlertConfig(workspaceId: string): Promise<AlertConfig> {
  return configOf(await loadSettings(workspaceId));
}

export async function saveAlertConfig(workspaceId: string, body: unknown): Promise<AlertConfig | string> {
  const current = await currentAlertConfig(workspaceId);
  const next = parseConfig(body, current);
  if (typeof next === "string") return next;
  await AlertSettings.updateOne({ workspaceId }, { $set: { rules: next.rules, channels: next.channels } });
  return next;
}

export async function sendTestAlert(workspace: { id: string; name: string }): Promise<DeliveryReport> {
  const config = await currentAlertConfig(workspace.id);
  const title = "Test alert from Quantalog";
  const summary = "This is how your alerts will arrive. Nothing is wrong with your site.";
  const sample: AlertCondition = {
    key: "test",
    rule: "trafficDrop",
    title,
    summary,
    siteId: "",
    link: "/app/alerts",
    notification: { type: "alert.triggered", data: { rule: "test", title, summary } },
  };
  return deliverAlerts(workspace, [sample], config.channels);
}

type WorkspaceLean = { _id: unknown; name?: string; apps?: Record<string, { enabled?: boolean } | undefined> };

async function checkWorkspace(
  settingsId: unknown,
  workspace: WorkspaceLean | undefined,
  sites: AlertSite[],
  plan: { checkEveryHours: number; lastFormSubmissionAt: Date | null },
  now: Date,
): Promise<{ fired: number; error?: string }> {
  const claimed = await AlertSettings.findOneAndUpdate(
    { _id: settingsId, nextCheckAt: { $lte: now } },
    { $set: { nextCheckAt: new Date(now.getTime() + CLAIM_MS) } },
    { new: true },
  ).lean<SettingsLean>();
  if (!claimed) return { fired: 0 };

  if (!workspace?.apps?.alerts?.enabled) {
    await AlertSettings.updateOne({ _id: settingsId }, { $set: { nextCheckAt: null } });
    return { fired: 0 };
  }

  const workspaceId = String(workspace._id);
  try {
    const config = configOf(claimed);
    const conditions = await evaluateAlerts({
      workspaceId,
      config,
      sites,
      goalsOn: Boolean(workspace.apps?.goals?.enabled),
      lastFormSubmissionAt: plan.lastFormSubmissionAt,
      now,
    });

    const previous = claimed.active ?? {};
    const active: Record<string, Date> = {};
    const fresh: AlertCondition[] = [];
    for (const c of conditions) {
      const key = stateKey(c.key);
      if (previous[key]) active[key] = previous[key];
      else {
        active[key] = now;
        fresh.push(c);
      }
    }

    if (fresh.length) {
      await Promise.all([
        deliverAlerts({ id: workspaceId, name: workspace.name ?? "your workspace" }, fresh, config.channels),
        AlertEvent.insertMany(
          fresh.map((c) => ({ workspaceId, rule: c.rule, title: c.title, summary: c.summary, siteId: c.siteId, link: c.link })),
          { ordered: false },
        ),
      ]);
    }

    await AlertSettings.updateOne(
      { _id: settingsId },
      { $set: { active, lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + plan.checkEveryHours * HOUR_MS) } },
    );
    return { fired: fresh.length };
  } catch (e) {
    await AlertSettings.updateOne({ _id: settingsId }, { $set: { nextCheckAt: new Date(now.getTime() + RETRY_MS) } });
    return { fired: 0, error: `${workspaceId}: ${(e as Error).message}` };
  }
}

export async function runDueAlerts(now = new Date()) {
  const due = await AlertSettings.find({ nextCheckAt: { $ne: null, $lte: now } })
    .sort({ nextCheckAt: 1 })
    .limit(BATCH_SIZE)
    .select("_id workspaceId")
    .lean<{ _id: unknown; workspaceId: unknown }[]>();
  if (!due.length) return { checked: 0, fired: 0, errors: [] as string[] };

  const workspaceIds = due.map((d) => String(d.workspaceId));
  const [workspaces, sites, plans] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select("name apps").lean<WorkspaceLean[]>(),
    Site.find({ workspaceId: { $in: workspaceIds } }).select("workspaceId siteId name").lean(),
    workspacePlans(workspaceIds),
  ]);

  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const sitesByWorkspace = new Map<string, AlertSite[]>();
  for (const s of sites) {
    const list = sitesByWorkspace.get(String(s.workspaceId)) ?? [];
    list.push({ siteId: String(s.siteId), name: String(s.name) });
    sitesByWorkspace.set(String(s.workspaceId), list);
  }

  const results = await pooled(due, CONCURRENCY, (d) => {
    const id = String(d.workspaceId);
    const info = plans.get(id);
    return checkWorkspace(
      d._id,
      workspaceById.get(id),
      sitesByWorkspace.get(id) ?? [],
      { checkEveryHours: info?.plan.alertCheckHours ?? 6, lastFormSubmissionAt: info?.lastFormSubmissionAt ?? null },
      now,
    );
  });

  return {
    checked: results.length,
    fired: results.reduce((sum, r) => sum + r.fired, 0),
    errors: results.flatMap((r) => (r.error ? [r.error] : [])),
  };
}
