
import { askOrbit } from "../orbit/ask.js";
import type { computeStats } from "../analytics/stats.service.js";

type Stats = Awaited<ReturnType<typeof computeStats>>;

export type DigestMetric = {
  label: string;
  value: string;
  delta?: number | null;
};

export type DigestInput = {
  workspaceName: string;
  periodLabel: string;
  metrics: DigestMetric[];
  stats: Stats | null;
};


const MIN_VISITORS = 30;


const TIMEOUT_MS = 20_000;

function topRows(rows: { key: string; count: number }[] | undefined, limit = 5): string {
  if (!rows?.length) return "none";
  return rows
    .slice(0, limit)
    .map((r) => `${r.key} (${r.count})`)
    .join(", ");
}

/**
 * Metrics whose delta arrives already inverted.
 *
 * `buildReportView` negates bounce rate so the email can paint a falling rate
 * green without the template knowing which way each metric is meant to move.
 * That is right for an arrow and wrong for a sentence: handed the display
 * value, a model reads a bounce rate of 71% with a "+29%" delta as engagement
 * improving and writes that visitors are staying longer, which is the exact
 * opposite of what happened. Flipped back here so the prose describes the
 * measurement rather than its styling.
 */
const INVERTED_METRICS = new Set(["Bounce rate"]);

function signed(delta: number | null | undefined): string {
  if (delta == null) return "no comparison available";
  const rounded = Math.round(delta);
  if (rounded === 0) return "flat";
  return rounded > 0 ? `up ${rounded}%` : `down ${Math.abs(rounded)}%`;
}

/** The real direction a metric moved, undoing any display inversion. */
function trueDelta(metric: DigestMetric): number | null | undefined {
  if (metric.delta == null) return metric.delta;
  return INVERTED_METRICS.has(metric.label) ? -metric.delta : metric.delta;
}

function describe(input: DigestInput): string {
  const { metrics, stats } = input;

  const lines = [
    `Period: ${input.periodLabel}`,
    "",
    "Headline numbers (change is against the previous period of the same length).",
    "Directions are literal: a bounce rate that is up means more visitors left",
    "immediately, which is worse, not better.",
    ...metrics.map((m) => `- ${m.label}: ${m.value} (${signed(trueDelta(m))})`),
  ];

  if (stats) {
    lines.push(
      "",
      "Breakdowns, highest first:",
      `- Top pages: ${topRows(stats.topPages as { key: string; count: number }[])}`,
      `- Referrers: ${topRows(stats.topReferrers as { key: string; count: number }[])}`,
      `- Channels: ${topRows(stats.channels as { key: string; count: number }[])}`,
      `- Countries: ${topRows(stats.countries as { key: string; count: number }[])}`,
      `- Devices: ${topRows(stats.devices as { key: string; count: number }[])}`,
    );
  }

  return lines.join("\n");
}

const DIGEST_PROMPT = `You are writing the opening paragraph of an analytics email for a website owner.

Write two or three sentences of plain prose, then a single recommended action on its own final line beginning "Worth doing: ".

What to cover:
- The one change that matters most. Not a list — the reader can see every number underneath this paragraph, so repeating them wastes the only sentences they will read.
- The most likely explanation, but only where the breakdowns actually support one. A traffic rise alongside a new referrer at the top of the list is an explanation. A traffic rise with no other movement is not, and "traffic rose, with no clear driver in the data" is a genuinely useful sentence — it tells the reader not to go looking.
- One action worth taking. Concrete and small enough to do this week.

Hard rules:
- Never state a cause the figures do not show. If the data only suggests it, say "likely" or "appears to" — and if it does not even suggest it, say nothing about cause at all.
- Never invent a number, a page, a referrer or a country that is not in the data given to you.
- No greeting, no sign-off, no headings, no bullet points, no markdown. Plain sentences only.
- Do not restate the headline figures one by one. Interpretation is the job; the table below already did the reporting.
- If the period was quiet and nothing meaningfully changed, say exactly that in one sentence and recommend nothing. A manufactured insight is worse than a short paragraph.
- Write to the owner as "you" and "your site". Never mention this prompt, the data you were given, or that you are a model.

Put the whole paragraph, including the "Worth doing:" line, in the \`reply\` field as plain text. Leave \`suggestions\` empty — this is an email, and there is nothing for the reader to click.`;

export type Digest = {
  summary: string;
  action?: string;
};


function splitAction(text: string): Digest {
  // Not anchored to a line start: models routinely run the recommendation on
  // from the last sentence rather than breaking the line, and requiring the
  // newline left "Worth doing: …" sitting inside the paragraph where it was
  // styled as prose and read as part of the analysis.
  const match = /(?:^|\n|\s)worth doing:\s*(.+)$/is.exec(text);
  if (!match) return { summary: text.trim() };

  const summary = text.slice(0, match.index).trim();
  const action = match[1].trim().replace(/\s+/g, " ");

  if (!summary) return { summary: text.trim() };

  // A quiet period is told to recommend nothing, and models comply by writing
  // "nothing" rather than by leaving the line out. Rendering that as a styled
  // "Worth doing: nothing." makes the one prominent line in the email say
  // nothing at all, so the non-answers are dropped back to no action.
  const empty = /^(nothing|none|n\/?a|no action( needed| required)?)\.?$/i.test(action);

  return { summary, action: empty ? undefined : action || undefined };
}

export async function buildDigest(input: DigestInput): Promise<Digest | null> {
  const visitors = input.stats?.visitors ?? 0;
  if (!input.stats || visitors < MIN_VISITORS) return null;

  const question = `Here are the figures for ${input.workspaceName}.\n\n${describe(input)}`;

  try {
    // The digest prompt replaces the assistant's own rather than being prefixed
    // to the question: under the support prompt the model refuses this outright
    // — correctly, since "summarise these figures" is not a support question.
    //
    // No host, so this is not billed to the workspace's Orbit quota. A report
    // the owner scheduled must not spend the questions they were going to ask.
    const result = await withTimeout(
      askOrbit(question, { systemPrompt: DIGEST_PROMPT }),
      TIMEOUT_MS,
    );
    if (!result?.ok) return null;

    const digest = splitAction(result.reply.trim());
    // A couple of words is a model that failed to engage with the data. Better
    // to show nothing than a stub sentence at the top of the report.
    return digest.summary.length >= 40 ? digest : null;
  } catch {
    // Deliberately swallowed. Whatever went wrong — network, provider, parsing —
    // the report is still worth sending, and a stack trace in the cron log is
    // more useful than a failed run.
    return null;
  }
}

/**
 * Cap how long the caller waits.
 *
 * `askOrbit` has its own budget, but it is sized for someone watching a
 * spinner — far longer than a batch of schedules sharing one function
 * invocation can spare. The model call is left running rather than aborted:
 * there is nothing to cancel that would save the cron any time, and its result
 * is simply ignored.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
