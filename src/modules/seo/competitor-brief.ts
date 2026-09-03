import { cloudflareChat, cloudflareReady } from "../orbit/cloudflare-ai.js";
import type { CompareSnapshot } from "./competitor.js";
import type { CompetitorGap, CompetitivePosition } from "./competitor-analysis.js";

/**
 * The competitive briefing: what the measured gaps actually mean.
 *
 * `compareSnapshots` answers "what is different" precisely and cannot answer
 * "so what". It knows their page carries 900 more words and declares FAQPage
 * schema; it does not know those two facts are the same finding — that they
 * built a support-content page and you built a brochure. Saying so is a
 * judgement about positioning, and that is what this asks a model for.
 *
 * Everything here is derived from the numbers already computed. The model is
 * given the comparison and asked to interpret it; it is never asked for facts
 * about a competitor, because it does not have any and would invent them. That
 * boundary is the whole design: measured data in, reading of that data out.
 *
 * Cloudflare Workers AI rather than the rest of Orbit's provider chain. The
 * OpenRouter models measured 17-31s per attempt on comparable prompts, which is
 * longer than anyone waits for a panel that is not the main content of the page.
 */

/** How long the whole generation gets before the panel gives up. */
const BUDGET_MS = 12_000;

/**
 * Llama 3.3 70B fp8, the same model Orbit leads its chain with.
 *
 * The 8B would be faster still, but this output is prose a customer reads and
 * acts on rather than a JSON plan a parser consumes, and the smaller model
 * writes noticeably blander copy on the same prompt.
 */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** One competitor as the model sees it. */
export type BriefInput = {
  label: string;
  theirScore: number;
  gap: CompetitorGap;
  snapshot: CompareSnapshot;
};

export type CompetitorBrief = {
  /** One sentence on where this competitor is actually beating you. */
  headline: string;
  /** What their page is optimised for, read off the measured signals. */
  theirStrategy: string;
  /** The single move with the best return, and why it is that one. */
  topMove: string;
  /** What you are already winning, so the brief is not purely a list of losses. */
  yourEdge: string;
};

export type BriefResult =
  | { ok: true; brief: CompetitorBrief; model: string }
  | { ok: false; reason: string };

/** Whether the feature can run at all, so the UI can hide rather than fail. */
export function briefingAvailable(): boolean {
  return cloudflareReady();
}

/**
 * The measured facts, flattened into something a model can read.
 *
 * Deliberately narrow. Only the comparison's own outputs go in — no raw HTML,
 * no page text, no URL beyond the label. A model given the page body starts
 * describing the competitor's business, which reads impressively and is exactly
 * the fabrication this must not ship.
 */
function factSheet(input: BriefInput, myScore: number, position: CompetitivePosition | null): string {
  const { gap, label, theirScore } = input;

  const losing = gap.metrics
    .filter((m) => m.verdict === "lose")
    // Impact order, so the model's attention lands where the score is actually
    // being lost rather than on whichever row was declared first.
    .sort((a, b) => b.impact - a.impact)
    .map((m) => `- ${m.label}: you ${m.mine}, them ${m.theirs}`)
    .join("\n");

  const winning = gap.metrics
    .filter((m) => m.verdict === "win")
    .map((m) => `- ${m.label}: you ${m.mine}, them ${m.theirs}`)
    .join("\n");

  const lines = [
    `COMPETITOR: ${label}`,
    `SCORES: yours ${myScore}, theirs ${theirScore} (${
      gap.scoreGap > 0 ? `they lead by ${gap.scoreGap}` : gap.scoreGap === 0 ? "level" : `you lead by ${-gap.scoreGap}`
    })`,
    position ? `YOUR RANK: ${position.rank} of ${position.fieldSize} tracked` : "",
    "",
    losing ? `WHERE THEY BEAT YOU:\n${losing}` : "WHERE THEY BEAT YOU: nothing measured",
    "",
    winning ? `WHERE YOU BEAT THEM:\n${winning}` : "WHERE YOU BEAT THEM: nothing measured",
    "",
    gap.contentGaps.length
      ? `SECTIONS ON THEIR PAGE, NOT YOURS: ${gap.contentGaps.join(", ")}`
      : "",
    gap.missingSchemaTypes.length
      ? `SCHEMA THEY DECLARE, YOU DO NOT: ${gap.missingSchemaTypes.join(", ")}`
      : "",
    gap.missingKeywords.length
      ? `TERMS PROMINENT ON THEIR PAGE, ABSENT FROM YOURS: ${gap.missingKeywords.join(", ")}`
      : "",
  ];

  return lines.filter(Boolean).join("\n");
}

const SYSTEM = `You are an SEO strategist reading a measured comparison between two web pages.

You will be given ONLY measured on-page facts. Interpret them. Do not invent anything.

HARD RULES:
- Never state a fact not present in the input. You do not know the competitor's traffic, rankings, revenue, backlinks, domain authority, or company. If you mention any of these you have failed.
- Never guess what their business does beyond what the section headings and terms literally show.
- Refer to the reader as "you" and the competitor by the given label.
- Plain language. No jargon the reader would have to look up, no "leverage" or "synergy".
- Every claim traces to a number in the input.

Reply with ONLY a JSON object, no markdown fence, no preamble:
{
  "headline": "one sentence, max 20 words, on where they are genuinely beating you",
  "theirStrategy": "2 sentences on what their page appears built to do, read strictly off the measured signals",
  "topMove": "2 sentences: the single highest-return change, and why it beats the alternatives",
  "yourEdge": "one sentence on what you are already winning. If nothing, say the comparison is close and name the nearest signal."
}`;

/**
 * Pull the JSON object out of a completion.
 *
 * Models wrap JSON in prose or a fence however firmly the prompt says not to,
 * so the object is located rather than assumed to be the whole reply. Failure
 * returns null and the caller degrades to the measured recommendations, which
 * are always there.
 */
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Accept only a fully-formed brief; a half-filled panel reads as broken. */
function validate(value: unknown): CompetitorBrief | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fields = ["headline", "theirStrategy", "topMove", "yourEdge"] as const;

  const out = {} as CompetitorBrief;
  for (const f of fields) {
    const raw = v[f];
    if (typeof raw !== "string" || !raw.trim()) return null;
    // Capped rather than truncated mid-generation: the panel has a fixed shape
    // and a model that ignored the word limit should not be able to stretch it.
    out[f] = raw.trim().slice(0, 400);
  }
  return out;
}

export async function generateBrief(
  input: BriefInput,
  myScore: number,
  position: CompetitivePosition | null
): Promise<BriefResult> {
  if (!briefingAvailable()) return { ok: false, reason: "AI briefing is not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);

  try {
    const res = await cloudflareChat({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: factSheet(input, myScore, position) },
      ],
      // Enough for four short fields with headroom; not enough to ramble.
      maxTokens: 700,
      // Low rather than zero: this is prose, and zero produces the same four
      // stock sentences for every competitor, which reads as a template.
      temperature: 0.4,
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 504 ? "The briefing took too long to generate" : "The briefing could not be generated",
      };
    }

    const brief = validate(extractJson(res.text));
    if (!brief) return { ok: false, reason: "The briefing came back malformed" };

    return { ok: true, brief, model: MODEL };
  } finally {
    clearTimeout(timer);
  }
}
