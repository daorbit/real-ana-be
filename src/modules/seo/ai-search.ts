import type { CheerioAPI } from "cheerio";
import { safeFetch } from "../../infra/http-client/safe-fetch.js";
import {
  isPathBlockedForAgent,
  type FileFinding,
  type RobotsGroup,
} from "./robots-validate.js";

/**
 * AI search readiness — whether answer engines can reach the page, and whether
 * what they find is shaped like something they can quote.
 *
 * This is deliberately a static audit. Nothing here queries ChatGPT or
 * Perplexity to see if the site gets cited: that costs money per scan, varies
 * run to run, and answers a different question. What it checks is the part the
 * site owner actually controls — crawler access, machine-readable structure,
 * and the attribution signals answer engines look for before quoting a source.
 */

/** How an AI crawler is treated by robots.txt. */
export type AiCrawlerAccess = {
  /** Product name shown in the UI, e.g. "ChatGPT". */
  label: string;
  /** The literal User-agent token, e.g. "GPTBot". */
  agent: string;
  /** What the bot is for — training a model, or fetching pages to cite live. */
  purpose: "training" | "answers" | "both";
  /** True when robots.txt lets this agent fetch the audited page. */
  allowed: boolean;
  /** True when a group names this agent, rather than it falling to the wildcard. */
  explicit: boolean;
};

export type AiSearchReport = {
  /** 0-100, the same shape as the other panel scores. */
  score: number;
  crawlers: AiCrawlerAccess[];
  /** Count of crawlers blocked from the audited page. */
  blockedCount: number;
  llmsTxt: {
    present: boolean;
    url: string;
    bytes: number;
    /** Top-level `#` heading, when the file has one. */
    title: string;
    /** Markdown link count — a usable llms.txt is mostly links. */
    linkCount: number;
  };
  /** Signals that decide whether an answer engine can quote the page. */
  answerReadiness: {
    /** Schema types that mark a page as quotable: FAQPage, HowTo, Article… */
    quotableSchemaTypes: string[];
    hasFaqSchema: boolean;
    hasArticleSchema: boolean;
    hasOrganizationSchema: boolean;
    /** Headings phrased as questions — the shape answer engines lift from. */
    questionHeadings: number;
    /** A visible author name, via schema or a byline meta tag. */
    hasAuthor: boolean;
    /** A machine-readable publish or update date. */
    hasDate: boolean;
    /** Definition lists and tables: dense, extractable facts. */
    structuredBlocks: number;
    wordCount: number;
  };
  findings: FileFinding[];
};

/**
 * The crawlers worth reporting on.
 *
 * `purpose` matters more than it looks: blocking a training bot is a valid
 * editorial choice with no effect on whether you get cited, while blocking a
 * live-retrieval bot removes you from answers outright. The UI grades those
 * differently, so the audit must not collapse them into one number.
 */
const AI_CRAWLERS: Omit<AiCrawlerAccess, "allowed" | "explicit">[] = [
  { label: "ChatGPT (browsing)", agent: "OAI-SearchBot", purpose: "answers" },
  { label: "ChatGPT (user fetch)", agent: "ChatGPT-User", purpose: "answers" },
  { label: "OpenAI (training)", agent: "GPTBot", purpose: "training" },
  { label: "Perplexity", agent: "PerplexityBot", purpose: "answers" },
  { label: "Claude (browsing)", agent: "Claude-User", purpose: "answers" },
  { label: "Claude (training)", agent: "ClaudeBot", purpose: "training" },
  { label: "Google AI", agent: "Google-Extended", purpose: "training" },
  { label: "Bing / Copilot", agent: "bingbot", purpose: "both" },
  { label: "Meta AI", agent: "meta-externalagent", purpose: "training" },
  { label: "Common Crawl", agent: "CCBot", purpose: "training" },
  { label: "Apple Intelligence", agent: "Applebot-Extended", purpose: "training" },
  { label: "Amazon", agent: "Amazonbot", purpose: "training" },
];

/** Heading text that reads as a question, in the languages we can cheaply detect. */
const QUESTION_PREFIX =
  /^(how|what|why|when|where|who|which|can|do|does|is|are|should|will|was|were)\b/i;

const LLMS_TIMEOUT = 8_000;

/* --------------------------------- llms.txt -------------------------------- */

/**
 * Fetch and lightly parse /llms.txt.
 *
 * The convention is a Markdown file of curated links that tells an LLM which
 * pages on the site are worth reading. It is not a standard anyone is required
 * to honour, so its absence is an opportunity rather than an error — reported
 * as `info`, never as a failure.
 */
async function checkLlmsTxt(origin: string): Promise<AiSearchReport["llmsTxt"]> {
  const url = `${origin}/llms.txt`;
  const out = { present: false, url, bytes: 0, title: "", linkCount: 0 };

  try {
    const res = await safeFetch(url, { timeoutMs: LLMS_TIMEOUT, maxBytes: 512 * 1024 });

    // Same trap as robots.txt: a soft 404 answers 200 with an HTML page.
    const looksLikeHtml = res.body.trimStart().startsWith("<");
    if (res.status !== 200 || looksLikeHtml) return out;

    out.present = true;
    out.bytes = Buffer.byteLength(res.body);
    out.title = (res.body.match(/^#\s+(.+)$/m)?.[1] ?? "").trim().slice(0, 200);
    out.linkCount = (res.body.match(/\[[^\]]*\]\([^)]+\)/g) ?? []).length;
  } catch {
    /* unreachable llms.txt is simply "not present" */
  }

  return out;
}

/* ------------------------------ page signals ------------------------------ */

/** Schema types that make a page directly quotable in an answer. */
const QUOTABLE_TYPES = [
  "faqpage", "qapage", "howto", "article", "newsarticle", "blogposting",
  "techarticle", "product", "recipe", "event", "dataset",
];

function readAnswerReadiness(
  $: CheerioAPI,
  schemaTypes: string[],
  wordCount: number
): AiSearchReport["answerReadiness"] {
  const types = schemaTypes.map((t) => t.toLowerCase());
  const has = (t: string) => types.includes(t);

  const questionHeadings = $("h1, h2, h3, h4")
    .toArray()
    .filter((el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      return text.endsWith("?") || QUESTION_PREFIX.test(text);
    }).length;

  // Author and date are checked in both the places they legitimately live: a
  // schema block, or plain meta tags on sites that never adopted JSON-LD.
  const hasAuthor =
    has("person") ||
    $('meta[name="author"], meta[property="article:author"], [itemprop="author"], [rel="author"]')
      .length > 0;

  const hasDate =
    $('meta[property="article:published_time"], meta[property="article:modified_time"], ' +
      'meta[name="date"], time[datetime], [itemprop="datePublished"], [itemprop="dateModified"]')
      .length > 0;

  return {
    quotableSchemaTypes: schemaTypes.filter((t) => QUOTABLE_TYPES.includes(t.toLowerCase())),
    hasFaqSchema: has("faqpage") || has("qapage"),
    hasArticleSchema: has("article") || has("newsarticle") || has("blogposting") || has("techarticle"),
    hasOrganizationSchema: has("organization") || has("localbusiness") || has("website"),
    questionHeadings,
    hasAuthor,
    hasDate,
    structuredBlocks: $("table, dl").length,
    wordCount,
  };
}

/* ---------------------------------- score --------------------------------- */

/**
 * Weighted so access dominates.
 *
 * Perfect structure on a page no answer engine may fetch is worth nothing, so
 * retrieval access is 60 of the 100 points and everything else splits the rest.
 */
function scoreReport(
  crawlers: AiCrawlerAccess[],
  llmsTxt: AiSearchReport["llmsTxt"],
  readiness: AiSearchReport["answerReadiness"]
): number {
  const retrieval = crawlers.filter((c) => c.purpose === "answers" || c.purpose === "both");
  const allowedRetrieval = retrieval.filter((c) => c.allowed).length;
  const access = retrieval.length > 0 ? (allowedRetrieval / retrieval.length) * 60 : 60;

  let structure = 0;
  if (readiness.hasFaqSchema) structure += 8;
  if (readiness.hasArticleSchema) structure += 7;
  if (readiness.hasOrganizationSchema) structure += 5;
  if (readiness.questionHeadings > 0) structure += 5;
  if (readiness.structuredBlocks > 0) structure += 3;
  structure = Math.min(structure, 25);

  let trust = 0;
  if (readiness.hasAuthor) trust += 4;
  if (readiness.hasDate) trust += 4;
  if (readiness.wordCount >= 300) trust += 2;

  const discovery = llmsTxt.present && llmsTxt.linkCount > 0 ? 5 : 0;

  return Math.max(0, Math.min(100, Math.round(access + structure + trust + discovery)));
}

/* -------------------------------- findings -------------------------------- */

function deriveFindings(
  crawlers: AiCrawlerAccess[],
  llmsTxt: AiSearchReport["llmsTxt"],
  readiness: AiSearchReport["answerReadiness"]
): FileFinding[] {
  const findings: FileFinding[] = [];

  const blockedRetrieval = crawlers.filter(
    (c) => !c.allowed && (c.purpose === "answers" || c.purpose === "both")
  );
  if (blockedRetrieval.length) {
    findings.push({
      severity: "critical",
      message:
        `robots.txt blocks ${blockedRetrieval.map((c) => c.agent).join(", ")} from this page. ` +
        "These crawlers fetch pages to cite in answers, so the page cannot appear in AI search results at all.",
    });
  }

  const blockedTraining = crawlers.filter((c) => !c.allowed && c.purpose === "training");
  if (blockedTraining.length) {
    findings.push({
      severity: "info",
      message:
        `Training crawlers blocked: ${blockedTraining.map((c) => c.agent).join(", ")}. ` +
        "This is a valid choice and does not affect whether you are cited in live answers.",
    });
  }

  if (!readiness.hasFaqSchema && readiness.questionHeadings >= 3) {
    findings.push({
      severity: "warning",
      message:
        `The page has ${readiness.questionHeadings} question-shaped headings but no FAQPage schema. ` +
        "Marking them up makes the answers directly extractable.",
    });
  }

  if (!readiness.hasAuthor || !readiness.hasDate) {
    const missing = [!readiness.hasAuthor && "author", !readiness.hasDate && "publish date"]
      .filter(Boolean)
      .join(" and ");
    findings.push({
      severity: "warning",
      message:
        `No machine-readable ${missing}. Answer engines prefer sources they can attribute and date-check.`,
    });
  }

  if (!readiness.hasOrganizationSchema) {
    findings.push({
      severity: "info",
      message:
        "No Organization or WebSite schema. This is how an answer engine learns what your brand is and how to name it.",
    });
  }

  if (!llmsTxt.present) {
    findings.push({
      severity: "info",
      message:
        "No /llms.txt. It is an emerging convention, not a requirement, but it lets you point LLMs at the pages you want quoted.",
    });
  } else if (llmsTxt.linkCount === 0) {
    findings.push({
      severity: "warning",
      message: "/llms.txt exists but lists no links, so it gives an LLM nothing to follow.",
    });
  }

  if (readiness.wordCount < 300) {
    findings.push({
      severity: "warning",
      message:
        `Only ${readiness.wordCount} words on the page. Answer engines rarely quote pages with too little substance to summarise.`,
    });
  }

  return findings;
}

/* --------------------------------- analyze -------------------------------- */

/**
 * Build the AI search report.
 *
 * Takes the already-parsed page and robots groups rather than re-fetching:
 * the only network call it makes on its own is /llms.txt.
 */
export async function analyzeAiSearch(
  $: CheerioAPI,
  finalUrl: string,
  robotsGroups: RobotsGroup[],
  schemaTypes: string[],
  wordCount: number
): Promise<AiSearchReport> {
  const parsed = new URL(finalUrl);
  const path = parsed.pathname || "/";

  const crawlers: AiCrawlerAccess[] = AI_CRAWLERS.map((c) => ({
    ...c,
    allowed: !isPathBlockedForAgent(robotsGroups, c.agent, path),
    explicit: robotsGroups.some((g) =>
      g.userAgents.some((a) => a.toLowerCase() === c.agent.toLowerCase())
    ),
  }));

  const llmsTxt = await checkLlmsTxt(parsed.origin);
  const answerReadiness = readAnswerReadiness($, schemaTypes, wordCount);

  return {
    score: scoreReport(crawlers, llmsTxt, answerReadiness),
    crawlers,
    blockedCount: crawlers.filter((c) => !c.allowed).length,
    llmsTxt,
    answerReadiness,
    findings: deriveFindings(crawlers, llmsTxt, answerReadiness),
  };
}
