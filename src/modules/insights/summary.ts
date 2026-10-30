import { askOrbit } from "../orbit/ask.js";
import type { Insight } from "./detect.js";

const TIMEOUT_MS = 20_000;
const MIN_LENGTH = 40;

const SUMMARY_PROMPT = `You write the two-sentence opening of a weekly website insights feed.

Rules:
- Two sentences of plain prose about the single most important change and what it most likely means.
- Use only the changes listed. Never invent a number, page, source or country.
- If a cause is not clear from the list, do not state one.
- No greeting, headings, bullet points or markdown. Write to the owner as "you".

Put the two sentences in the \`reply\` field and leave \`suggestions\` empty.`;

function describe(insights: Insight[], visitors: number, previous: number): string {
  return [
    `Visitors this week: ${visitors} (previous week: ${previous}).`,
    "Changes, most important first:",
    ...insights.map((i) => `- ${i.title}. ${i.body}`),
  ].join("\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

export async function summarizeWeek(insights: Insight[], visitors: number, previous: number): Promise<string> {
  if (!insights.length) return "";
  try {
    const result = await withTimeout(
      askOrbit(describe(insights, visitors, previous), { systemPrompt: SUMMARY_PROMPT }),
      TIMEOUT_MS,
    );
    const text = result?.ok ? result.reply.trim() : "";
    return text.length >= MIN_LENGTH ? text : "";
  } catch {
    return "";
  }
}
