import type { CompareSnapshot } from "./competitor.js";

/**
 * Turning two snapshots into the answer someone actually wants.
 *
 * A side-by-side table shows every number for both pages and leaves the reader
 * to work out which ones matter. This computes that judgement instead: where a
 * competitor genuinely beats you, by how much, and what to do about it.
 *
 * Kept on the server rather than in the page so the comparison the UI draws and
 * the one Orbit reasons from are the same computation. Two implementations of
 * "who is winning" would eventually disagree, and the one the user was not
 * looking at would be the one quoted back at them.
 */

/** Which side a metric favours. */
export type Verdict = "win" | "lose" | "tie";

export type MetricComparison = {
  /** Stable id, so the UI can key rows and pick its own labels. */
  id: string;
  label: string;
  /** Your value, already formatted for display. */
  mine: string;
  theirs: string;
  verdict: Verdict;
  /**
   * Why this metric matters, in one line. Present only when you are losing —
   * a row you already win needs no explanation.
   */
  note?: string;
  /**
   * Why a row that shows two different numbers is nonetheless a tie.
   *
   * Every comparison below carries a tolerance, because two pages are never
   * numerically identical and calling a 2-point difference a "loss" would fill
   * the table with defeats nobody can act on. Left unexplained, though, a row
   * reading "68 vs 70 — too close to call" looks like the comparison is broken.
   * Present only on ties that came from a tolerance, not on exact matches.
   */
  tieReason?: string;
  /**
   * Share of the on-page score this metric can move, 0-1.
   *
   * Lets the UI rank rows by what is actually costing points rather than by the
   * order they happen to be declared in. Approximate by design: the score is
   * not a clean weighted sum, so these are the penalty each signal carries
   * relative to the total penalty available.
   */
  weight: number;
  /**
   * How much this row matters right now: `weight` scaled by how far apart the
   * two pages are, 0-1. A heavily-weighted row you are tying on scores 0.
   */
  impact: number;
};

export type CompetitorGap = {
  /** How they score against you overall. Positive means they are ahead. */
  scoreGap: number;
  metrics: MetricComparison[];
  /** Words prominent on their page and absent from yours. */
  missingKeywords: string[];
  /** Schema types they declare and you do not. */
  missingSchemaTypes: string[];
  /** Topics from their outline with no counterpart in yours. */
  contentGaps: string[];
  /** The highest-value changes, already ordered. */
  recommendations: string[];
};

/**
 * The outcome of one comparison before it becomes a row.
 *
 * Carries `separation` — how far apart the two pages are on this signal, 0-1 —
 * so the caller can rank rows by what is actually costing points. A tie always
 * separates by 0 regardless of the raw numbers behind it: that is the whole
 * point of a tolerance.
 */
type Outcome = {
  verdict: Verdict;
  separation: number;
  tieReason?: string;
};

/**
 * How far apart two numbers are, relative to the larger of them.
 *
 * Relative rather than absolute because the metrics are on wildly different
 * scales — 200 ms and 200 words are not comparable magnitudes, but "30% apart"
 * means the same thing in both. Capped at 1 so one page having twenty times the
 * word count of another does not swamp every other row.
 */
function relativeGap(mine: number, theirs: number): number {
  const larger = Math.max(Math.abs(mine), Math.abs(theirs));
  if (larger === 0) return 0;
  return Math.min(1, Math.abs(mine - theirs) / larger);
}

/**
 * Explain a tie that two different numbers produced.
 *
 * Returned as prose rather than a raw tolerance figure because the reader is
 * being told why the table disagrees with their arithmetic, and "within the 2
 * we treat as noise" answers that where "tolerance: 2" does not. Exact matches
 * get no reason — nothing needs explaining when both sides read the same.
 */
function explainTie(mine: number, theirs: number, tolerance: number, unit: string): string | undefined {
  if (mine === theirs) return undefined;
  const rounded = Math.round(tolerance * 10) / 10;
  return `${mine} vs ${theirs} — within the ${rounded} ${unit} we treat as noise, not a real gap.`;
}

/** Compare two numbers where more is better. */
function moreIsBetter(mine: number, theirs: number, tolerance = 0, unit = ""): Outcome {
  if (Math.abs(mine - theirs) <= tolerance) {
    return { verdict: "tie", separation: 0, tieReason: explainTie(mine, theirs, tolerance, unit) };
  }
  return { verdict: mine > theirs ? "win" : "lose", separation: relativeGap(mine, theirs) };
}

/** Compare two numbers where less is better. */
function lessIsBetter(mine: number, theirs: number, tolerance = 0, unit = ""): Outcome {
  if (Math.abs(mine - theirs) <= tolerance) {
    return { verdict: "tie", separation: 0, tieReason: explainTie(mine, theirs, tolerance, unit) };
  }
  return { verdict: mine < theirs ? "win" : "lose", separation: relativeGap(mine, theirs) };
}

/**
 * Compare two booleans where having the thing is better.
 *
 * Separation is all-or-nothing: you either ship Open Graph tags or you do not,
 * and there is no partial credit to scale by.
 */
function havingIsBetter(mine: boolean, theirs: boolean): Outcome {
  if (mine === theirs) return { verdict: "tie", separation: 0 };
  return { verdict: mine ? "win" : "lose", separation: 1 };
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

/**
 * Whether a title or description length is in the range search engines show
 * without truncating. Both being "wrong" in different directions is a tie:
 * neither page is doing the right thing, and pretending one wins is noise.
 */
function lengthVerdict(
  mine: number,
  theirs: number,
  min: number,
  max: number
): Outcome {
  const mineOk = mine >= min && mine <= max;
  const theirsOk = theirs >= min && theirs <= max;
  if (mineOk === theirsOk) {
    return {
      verdict: "tie",
      separation: 0,
      // Two failures for different reasons is the case worth explaining: the
      // reader sees 12 against 78 marked a tie and needs to know that neither
      // number is in range, so neither page wins the row.
      tieReason: mineOk
        ? undefined
        : `Neither page is in the ${min}–${max} range, so neither wins this row.`,
    };
  }
  return { verdict: mineOk ? "win" : "lose", separation: 1 };
}

/** Normalise a heading to compare topics rather than exact wording. */
function topicKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How much of the on-page score each signal can move, 0-1.
 *
 * Derived from the penalties in `scoreSnapshot` rather than invented: a missing
 * title costs 15 points against roughly 100 points of available penalty, so it
 * weighs 0.15. Approximate on purpose — the score is not a clean weighted sum,
 * and these exist to rank rows sensibly, not to reconstruct the arithmetic.
 *
 * The overall score row is excluded from ranking entirely (weight 0): it is the
 * sum of the others, so letting it compete for the top of the table would just
 * pin the total above its own components.
 */
const METRIC_WEIGHTS: Record<string, number> = {
  score: 0,
  title: 0.15,
  description: 0.1,
  words: 0.15,
  headings: 0.08,
  schema: 0.12,
  "internal-links": 0.08,
  speed: 0.12,
  "page-weight": 0.06,
  "open-graph": 0.06,
  "alt-text": 0.08,
};

/** Assemble one row from its outcome, attaching the weight and derived impact. */
function row(
  id: string,
  label: string,
  mine: string,
  theirs: string,
  outcome: Outcome,
  note: string
): MetricComparison {
  const weight = METRIC_WEIGHTS[id] ?? 0;
  return {
    id,
    label,
    mine,
    theirs,
    verdict: outcome.verdict,
    note,
    tieReason: outcome.tieReason,
    weight,
    // Only rows you are losing carry impact. A signal you win is not costing
    // you anything, however heavily it is weighted, and sorting by "importance"
    // rather than "what is wrong" would lead the table with your own strengths.
    impact: outcome.verdict === "lose" ? weight * outcome.separation : 0,
  };
}

export function compareSnapshots(
  mine: CompareSnapshot,
  theirs: CompareSnapshot
): CompetitorGap {
  const metrics: MetricComparison[] = [
    row(
      "score",
      "On-page score",
      String(mine.score),
      String(theirs.score),
      moreIsBetter(mine.score, theirs.score, 2, "points"),
      "The blended on-page score. Every row below feeds it."
    ),
    row(
      "title",
      "Title length",
      `${mine.titleLength} chars`,
      `${theirs.titleLength} chars`,
      lengthVerdict(mine.titleLength, theirs.titleLength, 30, 60),
      "30–60 characters shows in full. Longer is truncated, shorter wastes the slot."
    ),
    row(
      "description",
      "Description length",
      `${mine.descriptionLength} chars`,
      `${theirs.descriptionLength} chars`,
      lengthVerdict(mine.descriptionLength, theirs.descriptionLength, 70, 160),
      "This is the text under your result, so it decides clicks."
    ),
    row(
      "words",
      "Word count",
      String(mine.wordCount),
      String(theirs.wordCount),
      // 15% either way is the same page depth in practice, not a real gap.
      moreIsBetter(mine.wordCount, theirs.wordCount, theirs.wordCount * 0.15, "words"),
      "Depth is not word count for its own sake, but a much thinner page rarely outranks a fuller one."
    ),
    row(
      "headings",
      "Section headings",
      String(mine.h2Count),
      String(theirs.h2Count),
      moreIsBetter(mine.h2Count, theirs.h2Count, 2, "headings"),
      "Headings are the page's outline — more sections usually means more questions answered."
    ),
    row(
      "schema",
      "Structured data",
      mine.hasStructuredData ? `${(mine.schemaTypes ?? []).length} types` : "None",
      theirs.hasStructuredData ? `${(theirs.schemaTypes ?? []).length} types` : "None",
      moreIsBetter((mine.schemaTypes ?? []).length, (theirs.schemaTypes ?? []).length),
      "Schema is what earns rich results and makes a page quotable by AI answer engines."
    ),
    row(
      "internal-links",
      "Internal links",
      String(mine.internalLinks),
      String(theirs.internalLinks),
      moreIsBetter(mine.internalLinks, theirs.internalLinks, 5, "links"),
      "Internal links spread authority and help crawlers find the rest of the site."
    ),
    row(
      "speed",
      "Response time",
      `${mine.responseTimeMs} ms`,
      `${theirs.responseTimeMs} ms`,
      lessIsBetter(mine.responseTimeMs, theirs.responseTimeMs, 200, "ms"),
      "Server response is the part of page speed no amount of front-end work can hide."
    ),
    row(
      "page-weight",
      "Page weight",
      `${Math.round(mine.pageBytes / 1024)} KB`,
      `${Math.round(theirs.pageBytes / 1024)} KB`,
      // Compared in KB rather than raw bytes so the explained tolerance reads
      // as "within the 50 KB we treat as noise" and not as 51200 of something.
      lessIsBetter(
        Math.round(mine.pageBytes / 1024),
        Math.round(theirs.pageBytes / 1024),
        50,
        "KB"
      ),
      "Lighter HTML reaches the visitor sooner, especially on mobile networks."
    ),
    row(
      "open-graph",
      "Open Graph tags",
      yesNo(mine.hasOpenGraph),
      yesNo(theirs.hasOpenGraph),
      havingIsBetter(mine.hasOpenGraph, theirs.hasOpenGraph),
      "Without these, links shared to social platforms render with no title or image."
    ),
    row(
      "alt-text",
      "Images missing alt",
      String(mine.imagesMissingAlt),
      String(theirs.imagesMissingAlt),
      lessIsBetter(mine.imagesMissingAlt, theirs.imagesMissingAlt, 1, "images"),
      "Alt text is both an accessibility requirement and how images get found in search."
    ),
  ];

  // Their prominent words that never appear on your page. Their own brand name
  // is excluded — "they mention themselves more than you do" is not a gap.
  //
  // Every list below is defaulted: a snapshot stored before these fields
  // shipped has none of them, and a competitor added last month must not crash
  // the comparison. A missing list yields an empty gap, which is the honest
  // answer — it was not measured, so nothing is known to be missing.
  const theirHost = safeHost(theirs.finalUrl);
  const mineWords = new Set((mine.keywords ?? []).map((k) => k.word));
  const missingKeywords = (theirs.keywords ?? [])
    .filter((k) => !mineWords.has(k.word))
    .filter((k) => !theirHost.includes(k.word))
    .slice(0, 10)
    .map((k) => k.word);

  const mineTypes = new Set((mine.schemaTypes ?? []).map((t) => t.toLowerCase()));
  const missingSchemaTypes = (theirs.schemaTypes ?? []).filter(
    (t) => !mineTypes.has(t.toLowerCase())
  );

  // Section topics they cover and you do not. Compared on normalised text, so
  // "Pricing" and "pricing." count as the same section.
  const mineTopics = new Set((mine.headings ?? []).map((h) => topicKey(h.text)));
  const contentGaps = (theirs.headings ?? [])
    .filter((h) => h.level === 2 || h.level === 3)
    .filter((h) => {
      const key = topicKey(h.text);
      return key.length > 3 && !mineTopics.has(key);
    })
    // A heading naming a topic is a content gap worth reporting; a heading that
    // is a marketing sentence is the same page's hero copy, and listing
    // "Analyze your brand's visibility across major AI search engines, track
    // mentions and links, and benchmark competitors to grow your presence" as a
    // section you are missing tells the reader nothing they can act on. Real
    // section headings are short — the cut is on word count rather than
    // characters, since a long single word is still a topic.
    .filter((h) => h.text.split(/\s+/).length <= 8)
    .slice(0, 8)
    .map((h) => h.text);

  return {
    scoreGap: theirs.score - mine.score,
    metrics,
    missingKeywords,
    missingSchemaTypes,
    contentGaps,
    recommendations: recommend(metrics, missingSchemaTypes, contentGaps, mine, theirs),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Where you stand in the tracked field.
 *
 * A per-competitor delta answers "am I ahead of them", which is the wrong
 * question once someone tracks more than one rival: "they lead by 7" says
 * nothing about whether that is last place or a close second. This is the set
 * viewed as a standings table instead.
 */
export type CompetitivePosition = {
  /** 1 is the top of the field. */
  rank: number;
  /** Competitors plus you, so `rank` reads as "N of fieldSize". */
  fieldSize: number;
  /** Share of the field you are ahead of, 0-100. */
  percentile: number;
  /** Label of whoever leads the field. Null when that is you. */
  leader: string | null;
  /** Points between you and the top. 0 when you lead. */
  gapToLeader: number;
  /** The competitor immediately above you — the winnable fight. */
  nextUp: { label: string; competitorId: string; gap: number } | null;
  /** The one immediately below, so a lead reads as defensible or precarious. */
  closestBehind: { label: string; competitorId: string; gap: number } | null;
};

/** The minimum a competitor entry needs for the standings to be computable. */
type Standable = {
  competitorId: string;
  label: string;
  snapshot: { score: number };
};

/**
 * Rank the field and locate yourself in it.
 *
 * Ties are ranked by standard competition ordering — two competitors on the
 * same score share a rank — because telling someone they are 4th when they are
 * level with 3rd is a distinction the score does not support.
 */
export function computePosition(
  myScore: number,
  competitors: Standable[]
): CompetitivePosition {
  const field = [
    { competitorId: "__me__", label: "You", score: myScore },
    ...competitors.map((c) => ({
      competitorId: c.competitorId,
      label: c.label,
      score: c.snapshot.score,
    })),
  ].sort((a, b) => b.score - a.score);

  const myIndex = field.findIndex((f) => f.competitorId === "__me__");
  // Competition ranking: everyone strictly above you pushes you down one.
  const rank = field.filter((f) => f.score > myScore).length + 1;
  const behindMe = field.filter((f) => f.competitorId !== "__me__" && f.score < myScore).length;

  const leader = field[0];
  const iLead = leader.competitorId === "__me__";

  // The nearest rival strictly above and strictly below, walking outward from
  // where you sit. Strict comparisons on purpose: someone level with you is
  // neither a gap to close nor a lead to defend.
  const above = [...field.slice(0, myIndex)].reverse().find((f) => f.score > myScore) ?? null;
  const below = field.slice(myIndex + 1).find((f) => f.score < myScore) ?? null;

  return {
    rank,
    fieldSize: field.length,
    // Share of *rivals* beaten, not of the whole field — being ahead of
    // yourself is not an achievement worth counting. A field of one is 100.
    percentile: competitors.length === 0 ? 100 : Math.round((behindMe / competitors.length) * 100),
    leader: iLead ? null : leader.label,
    gapToLeader: iLead ? 0 : leader.score - myScore,
    nextUp: above
      ? { label: above.label, competitorId: above.competitorId, gap: above.score - myScore }
      : null,
    closestBehind: below
      ? { label: below.label, competitorId: below.competitorId, gap: myScore - below.score }
      : null,
  };
}

/**
 * The changes worth making, hardest-hitting first.
 *
 * Ordered by how much each moves the score, not by how easy it is: a list that
 * opens with "add Twitter Card tags" while the page is 900 words short of the
 * competition is technically correct and practically useless.
 */
function recommend(
  metrics: MetricComparison[],
  missingSchemaTypes: string[],
  contentGaps: string[],
  mine: CompareSnapshot,
  theirs: CompareSnapshot
): string[] {
  const out: string[] = [];
  const losing = (id: string) => metrics.find((m) => m.id === id)?.verdict === "lose";

  if (losing("words")) {
    const gap = theirs.wordCount - mine.wordCount;
    out.push(
      `Their page carries ${gap.toLocaleString()} more words. Depth is not word count for its own sake — look at what those words cover before matching them.`
    );
  }

  if (contentGaps.length) {
    out.push(
      `They have sections you do not: ${contentGaps.slice(0, 3).join(", ")}. Each is a question a visitor asked that your page does not answer.`
    );
  }

  if (missingSchemaTypes.length) {
    out.push(
      `They declare ${missingSchemaTypes.join(", ")} schema and you do not. This is what earns rich results and makes a page quotable in AI answers.`
    );
  }

  if (losing("title")) {
    out.push(
      "Their title sits in the 30–60 character range and yours does not, so theirs shows in full where yours is cut off or under-used."
    );
  }

  if (losing("description")) {
    out.push(
      "Their meta description is better sized. That text is what appears under the search result, so it decides who gets the click."
    );
  }

  if (losing("internal-links")) {
    out.push(
      `They link to ${theirs.internalLinks} internal pages against your ${mine.internalLinks}. Internal links are how authority reaches the rest of your site.`
    );
  }

  if (losing("speed")) {
    out.push(
      `Their server answered in ${theirs.responseTimeMs} ms against your ${mine.responseTimeMs} ms. Server time is the part of page speed no front-end work can hide.`
    );
  }

  if (losing("alt-text")) {
    out.push(
      `You have ${mine.imagesMissingAlt} images with no alt text against their ${theirs.imagesMissingAlt}.`
    );
  }

  if (losing("open-graph")) {
    out.push(
      "They ship Open Graph tags and you do not, so their links preview properly when shared and yours do not."
    );
  }

  // Said plainly rather than left as an empty list, which reads like a bug.
  if (!out.length) {
    out.push(
      "Nothing material to fix against this competitor — you match or beat them on every signal measured here."
    );
  }

  return out;
}
