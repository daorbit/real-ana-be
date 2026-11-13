import { askOrbit } from "../orbit/ask.js";
import type { Signal } from "./types.js";

const TIMEOUT_MS = 15_000;
const MIN_LENGTH = 40;
const MAX_LENGTH = 420;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const CAUSAL = /\b(because|caused|due to|thanks to|as a result of)\b/i;

const PROMPT = `You rewrite one business finding in plain language for the owner.

Rules:
- Two short sentences: what changed, then why it is worth a look.
- Use only the facts given. Never add a number, percentage, date, page, form, source or cause that is not in the facts.
- Never say why it happened. Do not use the words "because", "caused" or "due to".
- No greeting, headings, lists or markdown. Write to the owner as "you".

Put the two sentences in the \`reply\` field and leave \`suggestions\` empty.`;

function shown(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function facts(signal: Signal): string {
  const lines = signal.metrics.map((m) => {
    const unit = m.unit === "percent" ? "%" : "";
    return m.previous === null
      ? `- ${m.label}: ${shown(m.current)}${unit}`
      : `- ${m.label}: ${shown(m.current)}${unit} now, ${shown(m.previous)}${unit} in the period before`;
  });
  return [
    `Finding: ${signal.title}.`,
    `Detail: ${signal.summary}`,
    `Period: the last ${signal.period.days} days.`,
    "Numbers:",
    ...lines,
  ].join("\n");
}

function normalise(raw: string): string {
  const plain = raw.replace(/,/g, "");
  const n = Number(plain);
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : plain;
}

function allowedNumbers(signal: Signal): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number) => allowed.add(normalise(String(Math.round(n * 10) / 10)));
  for (const m of signal.metrics) {
    add(m.current);
    add(Math.round(m.current));
    if (m.previous !== null) {
      add(m.previous);
      add(Math.round(m.previous));
      add(Math.abs(m.current - m.previous));
      if (m.previous > 0) add(Math.abs(Math.round(((m.current - m.previous) / m.previous) * 100)));
    }
  }
  add(signal.period.days);
  add(100);
  for (const text of [signal.title, signal.summary]) for (const match of text.match(NUMBER) ?? []) allowed.add(normalise(match));
  return allowed;
}

export function groundedReply(reply: string, signal: Signal): string | null {
  const text = reply.trim().replace(/\s+/g, " ");
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return null;
  if (CAUSAL.test(text) || /[#*`]/.test(text)) return null;
  const allowed = allowedNumbers(signal);
  for (const match of text.match(NUMBER) ?? []) if (!allowed.has(normalise(match))) return null;
  return text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function explainOne(signal: Signal): Promise<string> {
  try {
    const result = await withTimeout(askOrbit(facts(signal), { systemPrompt: PROMPT }), TIMEOUT_MS);
    return result?.ok ? (groundedReply(result.reply, signal) ?? "") : "";
  } catch {
    return "";
  }
}

export async function explainSignals(signals: Signal[]): Promise<Map<string, string>> {
  const replies = await Promise.all(signals.map(explainOne));
  return new Map(signals.map((s, i) => [s.fingerprint, replies[i]]));
}
