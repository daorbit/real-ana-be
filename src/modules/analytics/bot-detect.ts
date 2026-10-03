import type { IncomingHttpHeaders } from "http";
import { AI_CRAWLERS } from "../seo/ai-search.js";

export const TRAFFIC_KINDS = ["human", "ai", "crawler", "automation", "suspect"] as const;
export type TrafficKind = (typeof TRAFFIC_KINDS)[number];

export type TrafficVerdict = {
  kind: TrafficKind;
  name: string;
  signals: string[];
};

type UaRule = { re: RegExp; kind: TrafficKind; name: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const AI_RULES: UaRule[] = [
  ...AI_CRAWLERS.filter((c) => c.agent !== "bingbot").map((c) => ({
    re: new RegExp(escape(c.agent), "i"),
    kind: "ai" as const,
    name: c.label,
  })),
  { re: /Perplexity-User/i, kind: "ai", name: "Perplexity (user fetch)" },
  { re: /Claude-SearchBot/i, kind: "ai", name: "Claude (search)" },
  { re: /meta-externalfetcher/i, kind: "ai", name: "Meta AI (user fetch)" },
  { re: /MistralAI-User/i, kind: "ai", name: "Mistral (user fetch)" },
  { re: /DuckAssistBot/i, kind: "ai", name: "DuckDuckGo AI" },
  { re: /Bytespider/i, kind: "ai", name: "ByteDance" },
  { re: /cohere-ai/i, kind: "ai", name: "Cohere" },
  { re: /YouBot/i, kind: "ai", name: "You.com" },
  { re: /Google-CloudVertexBot/i, kind: "ai", name: "Google Vertex AI" },
];

const CRAWLER_RULES: UaRule[] = [
  { re: /Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google/i, kind: "crawler", name: "Google" },
  { re: /bingbot|BingPreview|adidxbot/i, kind: "crawler", name: "Bing" },
  { re: /Chrome-Lighthouse|Google Page Speed/i, kind: "crawler", name: "Lighthouse" },
  { re: /YandexBot|YandexRenderResourcesBot/i, kind: "crawler", name: "Yandex" },
  { re: /Baiduspider/i, kind: "crawler", name: "Baidu" },
  { re: /DuckDuckBot/i, kind: "crawler", name: "DuckDuckGo" },
  { re: /Applebot/i, kind: "crawler", name: "Apple" },
  { re: /Slurp/i, kind: "crawler", name: "Yahoo" },
  { re: /AhrefsBot|AhrefsSiteAudit/i, kind: "crawler", name: "Ahrefs" },
  { re: /SemrushBot|SiteAuditBot/i, kind: "crawler", name: "Semrush" },
  { re: /MJ12bot/i, kind: "crawler", name: "Majestic" },
  { re: /DotBot|rogerbot/i, kind: "crawler", name: "Moz" },
  { re: /Screaming Frog/i, kind: "crawler", name: "Screaming Frog" },
  { re: /facebookexternalhit|Facebot/i, kind: "crawler", name: "Facebook preview" },
  { re: /Twitterbot/i, kind: "crawler", name: "X preview" },
  { re: /LinkedInBot/i, kind: "crawler", name: "LinkedIn preview" },
  { re: /Slackbot/i, kind: "crawler", name: "Slack preview" },
  { re: /Discordbot/i, kind: "crawler", name: "Discord preview" },
  { re: /WhatsApp/i, kind: "crawler", name: "WhatsApp preview" },
  { re: /TelegramBot/i, kind: "crawler", name: "Telegram preview" },
  { re: /UptimeRobot|Pingdom|StatusCake|Site24x7|Better Uptime/i, kind: "crawler", name: "Uptime monitor" },
];

const AUTOMATION_UA = /HeadlessChrome|PhantomJS|SlimerJS|Electron\/|Puppeteer|Playwright|Selenium|Cypress/i;
const GENERIC_BOT_UA = /bot\b|crawler|spider|crawl|scrapy|python-requests|python-urllib|curl\/|wget\/|go-http-client|java\/|okhttp|axios\/|node-fetch|httpclient|libwww/i;

const STRONG_CLIENT_SIGNALS = new Set(["webdriver", "automation", "headless"]);
const WEAK_CLIENT_SIGNALS = new Set(["nolang", "nowindow", "swgl", "teleport", "noplugins"]);

const MAX_SIGNALS = 8;

export function parseClientSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => STRONG_CLIENT_SIGNALS.has(s) || WEAK_CLIENT_SIGNALS.has(s))
    ),
  ].slice(0, MAX_SIGNALS);
}

function signatureAgent(headers: IncomingHttpHeaders): string {
  const raw = headers["signature-agent"];
  return (Array.isArray(raw) ? raw.join(" ") : raw ?? "").toLowerCase();
}

export function classifyRequest(ua: string, headers: IncomingHttpHeaders): TrafficVerdict | null {
  const agent = signatureAgent(headers);
  if (agent.includes("chatgpt.com")) return { kind: "ai", name: "ChatGPT agent", signals: ["signed-agent"] };
  if (agent) return { kind: "ai", name: "Signed AI agent", signals: ["signed-agent"] };

  if (!ua) return { kind: "suspect", name: "No user agent", signals: ["no-ua"] };

  for (const rule of [...AI_RULES, ...CRAWLER_RULES]) {
    if (rule.re.test(ua)) return { kind: rule.kind, name: rule.name, signals: ["user-agent"] };
  }
  if (AUTOMATION_UA.test(ua)) return { kind: "automation", name: "Headless browser", signals: ["headless"] };
  if (GENERIC_BOT_UA.test(ua)) return { kind: "crawler", name: "Unidentified bot", signals: ["user-agent"] };
  return null;
}

export function classifyTraffic(request: TrafficVerdict | null, clientSignals: string[]): TrafficVerdict {
  if (request && request.kind !== "suspect") {
    return { ...request, signals: [...new Set([...request.signals, ...clientSignals])] };
  }

  const strong = clientSignals.filter((s) => STRONG_CLIENT_SIGNALS.has(s));
  if (strong.length) {
    return { kind: "automation", name: "Automated browser", signals: [...new Set([...(request?.signals ?? []), ...clientSignals])] };
  }

  const weak = clientSignals.filter((s) => WEAK_CLIENT_SIGNALS.has(s));
  if (request || weak.length >= 2) {
    return {
      kind: "suspect",
      name: request?.name ?? "Unusual browser",
      signals: [...new Set([...(request?.signals ?? []), ...clientSignals])],
    };
  }

  return { kind: "human", name: "", signals: weak };
}
