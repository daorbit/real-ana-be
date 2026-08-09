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

/** Compare two numbers where more is better. */
function moreIsBetter(mine: number, theirs: number, tolerance = 0): Verdict {
  if (Math.abs(mine - theirs) <= tolerance) return "tie";
  return mine > theirs ? "win" : "lose";
}

/** Compare two numbers where less is better. */
function lessIsBetter(mine: number, theirs: number, tolerance = 0): Verdict {
  if (Math.abs(mine - theirs) <= tolerance) return "tie";
  return mine < theirs ? "win" : "lose";
}

/** Compare two booleans where having the thing is better. */
function havingIsBetter(mine: boolean, theirs: boolean): Verdict {
  if (mine === theirs) return "tie";
  return mine ? "win" : "lose";
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

/**
 * Whether a title or description length is in the range search engines show
 * without truncating. Both being "wrong" in different directions is a tie:
 * neither page is doing the right thing, and pretending one wins is noise.
 */
function lengthVerdict(mine: number, theirs: number, min: number, max: number): Verdict {
  const mineOk = mine >= min && mine <= max;
  const theirsOk = theirs >= min && theirs <= max;
  if (mineOk === theirsOk) return "tie";
  return mineOk ? "win" : "lose";
}

/** Normalise a heading to compare topics rather than exact wording. */
function topicKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compareSnapshots(
  mine: CompareSnapshot,
  theirs: CompareSnapshot
): CompetitorGap {
  const metrics: MetricComparison[] = [
    {
      id: "score",
      label: "On-page score",
      mine: String(mine.score),
      theirs: String(theirs.score),
      verdict: moreIsBetter(mine.score, theirs.score, 2),
      note: "The blended on-page score. Every row below feeds it.",
    },
    {
      id: "title",
      label: "Title length",
      mine: `${mine.titleLength} chars`,
      theirs: `${theirs.titleLength} chars`,
      verdict: lengthVerdict(mine.titleLength, theirs.titleLength, 30, 60),
      note: "30–60 characters shows in full. Longer is truncated, shorter wastes the slot.",
    },
    {
      id: "description",
      label: "Description length",
      mine: `${mine.descriptionLength} chars`,
      theirs: `${theirs.descriptionLength} chars`,
      verdict: lengthVerdict(mine.descriptionLength, theirs.descriptionLength, 70, 160),
      note: "This is the text under your result, so it decides clicks.",
    },
    {
      id: "words",
      label: "Word count",
      mine: String(mine.wordCount),
      theirs: String(theirs.wordCount),
      // 15% either way is the same page depth in practice, not a real gap.
      verdict: moreIsBetter(mine.wordCount, theirs.wordCount, theirs.wordCount * 0.15),
      note: "Depth is not word count for its own sake, but a much thinner page rarely outranks a fuller one.",
    },
    {
      id: "headings",
      label: "Section headings",
      mine: String(mine.h2Count),
      theirs: String(theirs.h2Count),
      verdict: moreIsBetter(mine.h2Count, theirs.h2Count, 2),
      note: "Headings are the page's outline — more sections usually means more questions answered.",
    },
    {
      id: "schema",
      label: "Structured data",
      mine: mine.hasStructuredData ? `${(mine.schemaTypes ?? []).length} types` : "None",
      theirs: theirs.hasStructuredData ? `${(theirs.schemaTypes ?? []).length} types` : "None",
      verdict: moreIsBetter((mine.schemaTypes ?? []).length, (theirs.schemaTypes ?? []).length),
      note: "Schema is what earns rich results and makes a page quotable by AI answer engines.",
    },
    {
      id: "internal-links",
      label: "Internal links",
      mine: String(mine.internalLinks),
      theirs: String(theirs.internalLinks),
      verdict: moreIsBetter(mine.internalLinks, theirs.internalLinks, 5),
      note: "Internal links spread authority and help crawlers find the rest of the site.",
    },
    {
      id: "speed",
      label: "Response time",
      mine: `${mine.responseTimeMs} ms`,
      theirs: `${theirs.responseTimeMs} ms`,
      verdict: lessIsBetter(mine.responseTimeMs, theirs.responseTimeMs, 200),
      note: "Server response is the part of page speed no amount of front-end work can hide.",
    },
    {
      id: "page-weight",
      label: "Page weight",
      mine: `${Math.round(mine.pageBytes / 1024)} KB`,
      theirs: `${Math.round(theirs.pageBytes / 1024)} KB`,
      verdict: lessIsBetter(mine.pageBytes, theirs.pageBytes, 50 * 1024),
      note: "Lighter HTML reaches the visitor sooner, especially on mobile networks.",
    },
    {
      id: "open-graph",
      label: "Open Graph tags",
      mine: yesNo(mine.hasOpenGraph),
      theirs: yesNo(theirs.hasOpenGraph),
      verdict: havingIsBetter(mine.hasOpenGraph, theirs.hasOpenGraph),
      note: "Without these, links shared to social platforms render with no title or image.",
    },
    {
      id: "alt-text",
      label: "Images missing alt",
      mine: String(mine.imagesMissingAlt),
      theirs: String(theirs.imagesMissingAlt),
      verdict: lessIsBetter(mine.imagesMissingAlt, theirs.imagesMissingAlt, 1),
      note: "Alt text is both an accessibility requirement and how images get found in search.",
    },
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
