import axios from "axios";
import mongoose from "mongoose";
import { Event } from "../analytics/models/Event.js";
import type { StatusComponentId } from "./components.js";
import { apiUrl, dashboardUrl, serviceUrl } from "./urls.js";

const TIMEOUT_MS = 6_000;
const SLOW_MS = 3_000;
const EVENT_WINDOW_MS = 60 * 60 * 1000;

export type ProbeResult = { ok: boolean; slow: boolean; latencyMs: number | null; message: string };

type Probe = { id: StatusComponentId; run: () => Promise<ProbeResult | null> };

async function timed(work: () => Promise<string>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const message = await work();
    const latencyMs = Date.now() - started;
    return { ok: true, slow: latencyMs > SLOW_MS, latencyMs, message: latencyMs > SLOW_MS ? `Slow: answered in ${latencyMs} ms` : message };
  } catch (e) {
    return { ok: false, slow: false, latencyMs: Date.now() - started, message: (e as Error)?.message?.slice(0, 200) || "No answer" };
  }
}

async function httpOk(url: string): Promise<string> {
  const { status } = await axios.get(url, { timeout: TIMEOUT_MS, maxRedirects: 3, validateStatus: () => true, responseType: "text" });
  if (status >= 500 || status === 0) throw new Error(`Answered ${status}`);
  return `Answered ${status}`;
}

function probeUrl(base: string, path: string): () => Promise<ProbeResult | null> {
  return async () => (base ? timed(() => httpOk(`${base}${path}`)) : null);
}

async function trackingProbe(): Promise<ProbeResult | null> {
  const result = await timed(() => httpOk(`${apiUrl()}/tracker.js`));
  if (!result.ok) return result;

  const siteIds = (process.env.STATUS_TRACKING_SITE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!siteIds.length) return result;
  const recent = await Event.exists({ siteId: { $in: siteIds }, ts: { $gte: new Date(Date.now() - EVENT_WINDOW_MS) } });
  return recent ? result : { ...result, slow: true, message: "The script loads, but no events arrived from the reference sites in the last hour" };
}

async function apiProbe(): Promise<ProbeResult> {
  return timed(async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database is not connected");
    await db.admin().ping();
    return "Database answered";
  });
}

export const PROBES: Probe[] = [
  { id: "api", run: apiProbe },
  { id: "dashboard", run: probeUrl(dashboardUrl(), "/") },
  { id: "tracking", run: trackingProbe },
  { id: "forms", run: probeUrl(serviceUrl(process.env.FORMS_API_BASE), "/api/health") },
  { id: "invoicing", run: probeUrl(serviceUrl(process.env.INVOICES_API_BASE), "/api/health") },
  { id: "jobs", run: async () => ({ ok: true, slow: false, latencyMs: null, message: "The scheduler ran" }) },
];
