import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { Goal } from "../models/Goal.js";
 
const DEMO_EMAIL = "demo@quantalog.local";
const FRESH_MS = 12 * 60 * 60 * 1000; // 12 hours

const PAGES = ["/", "/pricing", "/blog/real-time-analytics", "/docs", "/features", "/blog/privacy-first", "/changelog", "/about"];
const REFERRERS = ["", "", "", "https://google.com", "https://news.ycombinator.com", "https://twitter.com", "https://github.com", "https://reddit.com"];
const COUNTRIES = ["US", "GB", "IN", "DE", "CA", "FR", "BR", "AU", "NL", "JP"];
const DEVICES: [string, number][] = [["desktop", 0.62], ["mobile", 0.33], ["tablet", 0.05]];
const BROWSERS = ["Chrome", "Chrome", "Chrome", "Safari", "Safari", "Firefox", "Edge"];
const OSES = ["Windows", "macOS", "iOS", "Android", "Linux"];
const LANGS = ["en-US", "en-GB", "de-DE", "fr-FR", "pt-BR", "hi-IN"];
const SOURCES = ["google", "newsletter", "twitter", "producthunt"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weighted(pairs: [string, number][]): string {
  const r = Math.random();
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (r <= acc) return v;
  }
  return pairs[0][0];
}

 
function eventsForDay(siteId: string, day: Date, sessions: number) {
  const docs: Record<string, unknown>[] = [];
  for (let s = 0; s < sessions; s++) {
    const visitorHash = nanoid(12);
    const sessionId = nanoid(12);
    const country = pick(COUNTRIES);
    const device = weighted(DEVICES);
    const browser = pick(BROWSERS);
    const os = pick(OSES);
    const language = pick(LANGS);
    const referrer = pick(REFERRERS);
    const useUtm = Math.random() < 0.25;
    const utm = useUtm
      ? { source: pick(SOURCES), medium: "cpc", campaign: "launch" }
      : { source: "", medium: "", campaign: "" };

    // A visit is 1-5 pages; a single-page visit is a bounce.
    const depth = 1 + Math.floor(Math.random() * (Math.random() < 0.45 ? 1 : 5));
    const entryPath = pick(PAGES);
    // Spread the session's events through the day.
    const base = new Date(day);
    base.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60));

    for (let p = 0; p < depth; p++) {
      const path = p === 0 ? entryPath : pick(PAGES);
      const ts = new Date(base.getTime() + p * 45_000);
      const isEntry = p === 0;
      const isExit = p === depth - 1;
      const ctx = {
        siteId, path, referrer: isEntry ? referrer : "", visitorHash, sessionId,
        device, os, browser, country, language, entryPath, utm,
        screenW: device === "mobile" ? 390 : 1440,
        screenH: device === "mobile" ? 844 : 900,
        viewportW: device === "mobile" ? 390 : 1440,
        viewportH: device === "mobile" ? 780 : 820,
      };
      docs.push({ ...ctx, type: "pageview", isEntry, isExit, ts });
      if (isExit) {
        docs.push({
          ...ctx,
          type: "engagement",
          isExit: true,
          durationMs: 8000 + Math.floor(Math.random() * 120_000),
          bounce: depth === 1,
          scrollDepth: 25 + Math.floor(Math.random() * 75),
          vitals: {
            lcp: 1600 + Math.floor(Math.random() * 2200),
            cls: Math.round(Math.random() * 15) / 100,
            inp: 90 + Math.floor(Math.random() * 220),
            fcp: 1000 + Math.floor(Math.random() * 1400),
            ttfb: 200 + Math.floor(Math.random() * 700),
          },
          ts: new Date(ts.getTime() + 30_000),
        });
      }
    }
  }
  return docs;
}

 async function seedTraffic(siteId: string, days = 30) {
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000);
     const weekend = day.getDay() === 0 || day.getDay() === 6;
    const sessions = (weekend ? 40 : 90) + Math.floor(Math.random() * 40);
    const docs = eventsForDay(siteId, day, sessions);
    if (docs.length) await Event.insertMany(docs, { ordered: false }).catch(() => {});
  }
}

 
export async function ensureDemoUser(): Promise<string> {
  let user = await User.findOne({ isDemo: true });
  if (!user) {
    user = await User.create({
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash(nanoid(24), 10),
      name: "Demo User",
      firstName: "Demo",
      lastName: "User",
      role: "user",
      isDemo: true,
    });
  }

  let ws = await Workspace.findOne({ userId: user.id });
  if (!ws) {
    ws = await Workspace.create({ userId: user.id, name: "Acme Inc.", slug: `demo-${nanoid(6)}` });
  }

  let sites = await Site.find({ workspaceId: ws.id });
  if (sites.length === 0) {
    sites = await Site.create([
      { workspaceId: ws.id, userId: user.id, name: "Acme Marketing", domain: "https://acme.example", framework: "react", siteId: nanoid(16) },
      { workspaceId: ws.id, userId: user.id, name: "Acme Docs", domain: "https://docs.acme.example", framework: "other", siteId: nanoid(16) },
    ]);
  }

  const goals = await Goal.countDocuments({ workspaceId: ws.id });
  if (goals === 0) {
    await Goal.create([
      { workspaceId: ws.id, name: "Signup", kind: "page", match: "/signup" },
      { workspaceId: ws.id, name: "Pricing viewed", kind: "page", match: "/pricing" },
    ]);
  }

  // Top up traffic only when the newest event is stale, so repeated demo logins
  // don't pile on duplicate days.
  const primary = sites[0];
  const newest = await Event.findOne({ siteId: primary.siteId }).sort({ ts: -1 }).select("ts");
  const stale = !newest || Date.now() - new Date(newest.get("ts")).getTime() > FRESH_MS;
  if (stale) {
    for (const site of sites) {
      // A first-time seed fills the month; a refresh only needs the last day or two.
      const existing = await Event.countDocuments({ siteId: site.siteId });
      await seedTraffic(site.siteId, existing === 0 ? 30 : 2);
    }
  }

  return user.id;
}
