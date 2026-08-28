 

import { ORBIT_KNOWLEDGE } from "./prompt.js";

/** One `## Heading` block of the reference, with its text. */
export interface KnowledgeSection {
  heading: string;
  body: string;
  /** Words that should pull this section in, beyond the words in its own text. */
  cues: string[];
}

 
const SECTION_CUES: Record<string, string[]> = {
  "Core concepts": [
    "workspace", "site", "visitor", "unique", "cookie", "banner", "consent",
    "gdpr", "privacy", "hash", "anonymous", "count", "counted",
  ],
  "Installing the tracker": [
    "install", "snippet", "script", "tag", "setup", "set up", "embed", "head",
    "react", "next", "vue", "spa", "wordpress", "shopify", "not working",
    "no data", "nothing showing", "verify", "blocked", "adblock",
  ],
  Analytics: [
    "traffic", "pageview", "views", "visitors", "sessions", "bounce", "referrer",
    "source", "channel", "country", "device", "browser", "segment", "marker",
    "filter", "range", "dashboard", "chart", "drop", "spike", "down", "up",
    "realtime", "live",
  ],
  SEO: [
    "seo", "audit", "crawl", "lighthouse", "meta", "title", "description",
    "canonical", "schema", "structured", "sitemap", "robots", "broken", "link",
    "redirect", "competitor", "rank", "keyword", "score", "core web vitals",
    "vitals", "speed", "performance",
  ],
  "Impersonation and admin": ["impersonate", "admin", "staff", "support access", "super"],
  Reports: [
    "report", "schedule", "email", "weekly", "monthly", "daily", "pdf",
    "spreadsheet", "excel", "csv", "whatsapp", "recipient", "unsubscribe",
    "export", "download",
  ],
  "Scheduled LinkedIn posts": [
    "linkedin", "post", "social", "publish", "studio", "schedule post",
    "instagram", "caption", "image",
  ],
  Sharing: ["share", "public", "link", "client", "read-only", "password", "embed dashboard"],
  "Team and permissions": [
    "team", "member", "invite", "role", "permission", "owner", "admin", "editor",
    "viewer", "access", "remove", "seat",
  ],
  API: [
    "api", "key", "endpoint", "rest", "platform", "token", "curl", "webhook",
    "integration", "programmatic", "trace", "journey",
  ],
  Billing: [
    "billing", "plan", "price", "cost", "upgrade", "downgrade", "quota", "limit",
    "invoice", "payment", "card", "refund", "trial", "addon", "add-on", "pack",
    "subscription", "renew", "expired", "coupon",
  ],
  Account: [
    "account", "password", "login", "sign in", "signin", "email", "profile",
    "avatar", "delete account", "2fa", "logout", "reset",
  ],
};

 
function splitSections(): { preamble: string; sections: KnowledgeSection[] } {
  const text = ORBIT_KNOWLEDGE.trim();
  const parts = text.split(/\n(?=## )/);
  const preamble = parts[0].startsWith("## ") ? "" : parts.shift() ?? "";

  const sections = parts.map((block) => {
    const heading = block.slice(3, block.indexOf("\n")).trim();
    return {
      heading,
      body: block.trim(),
      cues: SECTION_CUES[heading] ?? [],
    };
  });

  return { preamble: preamble.trim(), sections };
}

const { preamble: PREAMBLE, sections: SECTIONS } = splitSections();

/** Always sent: the other sections assume its vocabulary. */
const ALWAYS = "Core concepts";

/** How many scoring sections travel alongside the always-on one. */
const MAX_SECTIONS = 3;

 
function score(section: KnowledgeSection, question: string): number {
  const q = ` ${question.toLowerCase()} `;
  let total = 0;

  for (const cue of section.cues) {
    if (!q.includes(cue)) continue;
    total += cue.includes(" ") ? 6 : 3;
  }

  // The heading itself, which users often quote back ("the SEO page").
  if (q.includes(section.heading.toLowerCase())) total += 5;

  return total;
}

 
export function relevantKnowledge(question: string): string {
  if (!question.trim() || SECTIONS.length === 0) return ORBIT_KNOWLEDGE;

  const scored = SECTIONS
    .filter((s) => s.heading !== ALWAYS)
    .map((s) => ({ section: s, score: score(s, question) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // The always-on section is excluded from the ranking (it travels regardless)
  // but its cues still count as a match: "do I need a cookie banner" scores
  // only under Core concepts, and treating that as "matched nothing" sent the
  // whole reference for a question the always-on section already answers.
  const alwaysMatched = score(
    SECTIONS.find((s) => s.heading === ALWAYS) ?? { heading: "", body: "", cues: [] },
    question,
  ) > 0;

  if (scored.length === 0 && !alwaysMatched) return ORBIT_KNOWLEDGE;
  if (scored.length === 0) {
    const always = SECTIONS.find((s) => s.heading === ALWAYS);
    return [PREAMBLE, always?.body].filter(Boolean).join("\n\n");
  }

  // Ties at the cut-off line are kept rather than broken arbitrarily: two
  // sections scoring equally are equally likely to hold the answer, and the
  // cost of one more is far below the cost of missing it.
  const cutoff = scored[Math.min(MAX_SECTIONS, scored.length) - 1].score;
  const picked = scored.filter((s) => s.score >= cutoff).map((s) => s.section);

  const always = SECTIONS.find((s) => s.heading === ALWAYS);
  const ordered = SECTIONS.filter(
    (s) => s === always || picked.includes(s),
  );

  return [PREAMBLE, ...ordered.map((s) => s.body)].filter(Boolean).join("\n\n");
}

/** Section headings, for logging what a question actually pulled in. */
export function selectedHeadings(question: string): string[] {
  const selected = relevantKnowledge(question);
  return SECTIONS.filter((s) => selected.includes(s.body)).map((s) => s.heading);
}
