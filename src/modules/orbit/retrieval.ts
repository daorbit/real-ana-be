
import { orbitKnowledge } from "./corpus.js";

export interface KnowledgeSection {
  /** The page title, as rendered into the corpus under `## `. */
  heading: string;
  /** The page's doc slug, or "" for a section that is not a documentation page. */
  slug: string;
  /** The line beneath the heading: the page's own description. */
  summary: string;
  body: string;
}

/**
 * Words too common in this corpus to tell one page from another.
 *
 * Every page says "Quantalog" and most say "site" or "page", so matching on
 * them ranks by page length rather than by relevance.
 */
const STOP = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can",
  "do", "does", "for", "from", "get", "has", "have", "how", "i", "if", "in",
  "is", "it", "its", "me", "my", "no", "not", "of", "on", "one", "or", "our",
  "out", "so", "that", "the", "their", "them", "then", "there", "they", "this",
  "to", "up", "use", "used", "using", "want", "was", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your",
  "quantalog", "page", "pages", "site", "sites", "data", "set", "see", "need",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Crude singular/plural folding, so "forms" matches "form".
 *
 * Not a stemmer. A real one would also fold "billing" to "bill" and start
 * matching pages about invoices to questions about a bill of materials; this
 * handles the one case that actually costs recall here.
 */
function fold(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function splitSections(corpus: string): {
  preamble: string;
  sections: KnowledgeSection[];
} {
  const text = corpus.trim();
  const parts = text.split(/\n(?=## )/);
  const preamble = parts[0].startsWith("## ") ? "" : (parts.shift() ?? "");

  const sections = parts.map((block) => {
    const firstBreak = block.indexOf("\n");
    const rawHeading = block.slice(3, firstBreak === -1 ? undefined : firstBreak).trim();
    const rest = firstBreak === -1 ? "" : block.slice(firstBreak + 1).trim();
    const summary = rest.split("\n\n")[0]?.trim() ?? "";

    // "Lead capture [/docs/lead-capture]" — the slug is carried on the heading
    // line so the corpus stays one flat document, and split back out here.
    const slugMatch = rawHeading.match(/\s*\[\/docs\/([a-z0-9-]+)\]$/);

    return {
      heading: slugMatch ? rawHeading.slice(0, slugMatch.index).trim() : rawHeading,
      slug: slugMatch?.[1] ?? "",
      summary,
      body: block.trim(),
    };
  });

  return { preamble: preamble.trim(), sections };
}

/**
 * The parsed corpus, recomputed when the corpus text changes.
 *
 * Keyed on the text itself rather than on a timer: the fetch refreshes on its
 * own schedule and usually returns something identical, and re-splitting 80KB
 * on every question to discover that would be waste.
 */
let parsedFor = "";
let parsed = splitSections("");

function sections(): { preamble: string; sections: KnowledgeSection[] } {
  const corpus = orbitKnowledge();
  if (corpus !== parsedFor) {
    parsed = splitSections(corpus);
    parsedFor = corpus;
  }
  return parsed;
}

/** How many sections travel with an answer. */
const MAX_SECTIONS = 3;

/**
 * How well one page answers a question.
 *
 * Scored against the page's title and its own one-line description rather than
 * its full text: a long page mentions almost everything once, so matching the
 * body ranks by length. The title and description are what the page is *about*,
 * which is the question being asked here.
 *
 * This replaced a hand-maintained list of cue words per section. That list was
 * half of why Orbit could not answer about lead capture — the page existed, but
 * nobody had added "lead", "form" or "submission" to its cues, so it scored
 * zero and was never selected. A cue list is a third copy of the documentation,
 * and it went stale the same way the other two did.
 */
function score(section: KnowledgeSection, questionWords: Set<string>): number {
  let total = 0;

  const title = new Set(tokenize(section.heading).map(fold));
  for (const word of title) if (questionWords.has(word)) total += 6;

  const summary = new Set(tokenize(section.summary).map(fold));
  for (const word of summary) if (questionWords.has(word)) total += 2;

  // The whole heading quoted back — "the SEO page", "lead capture" — is the
  // strongest signal there is, and survives the tokenizer dropping stop words.
  if (section.heading && questionWords.size > 0) {
    const heading = section.heading.toLowerCase();
    const joined = [...questionWords].join(" ");
    if (joined.includes(heading) || heading.split(/\s+/).every((w) => questionWords.has(fold(w)))) {
      total += 5;
    }
  }

  return total;
}

/**
 * The reference sections worth sending for one question.
 *
 * Falls back to the entire corpus when nothing scores. That is the safe
 * direction: a larger prompt costs tokens, while a wrong selection costs the
 * answer — the model is told to answer only from what it is given, so a section
 * withheld reads to the user as a feature that does not exist.
 */
export function relevantKnowledge(question: string): string {
  const { preamble, sections: all } = sections();
  if (!question.trim() || all.length === 0) return orbitKnowledge();

  const words = new Set(tokenize(question).map(fold));

  const scored = all
    .map((section) => ({ section, score: score(section, words) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return orbitKnowledge();

  // Ties at the cut-off are kept rather than broken arbitrarily: two sections
  // scoring equally are equally likely to hold the answer, and one more section
  // costs far less than missing it.
  const cutoff = scored[Math.min(MAX_SECTIONS, scored.length) - 1].score;
  const picked = scored.filter((s) => s.score >= cutoff).map((s) => s.section);

  // Corpus order, not score order: the pages were written to be read in
  // sequence, and shuffling them puts an advanced page before the one defining
  // its vocabulary.
  const ordered = all.filter((s) => picked.includes(s));

  return [preamble, ...ordered.map((s) => s.body)].filter(Boolean).join("\n\n");
}

/**
 * The pages Orbit may link to, as the rules prompt lists them.
 *
 * Derived from the corpus rather than maintained by hand. The previous list
 * was written out in the backend and had gone stale in both directions at once
 * — it omitted `lead-capture`, which was published and which Orbit was
 * therefore forbidden to link, while Orbit's own knowledge of the feature was
 * missing too. Deriving it means a page that exists is a page Orbit can cite.
 */
export function docIndex(): string {
  return sections()
    .sections.filter((s) => s.slug)
    .map((s) => `- /docs/${s.slug} — ${s.summary || s.heading}`)
    .join("\n");
}

/** Section headings, for logging what a question actually pulled in. */
export function selectedHeadings(question: string): string[] {
  const selected = relevantKnowledge(question);
  return sections()
    .sections.filter((s) => selected.includes(s.body))
    .map((s) => s.heading);
}
