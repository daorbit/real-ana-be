import type { CompareSnapshot } from "./competitor.js";

export type Verdict = "win" | "lose" | "tie";

export type MetricComparison = {
  id: string;
  label: string;
  mine: string;
  theirs: string;
  verdict: Verdict;
  note?: string;
  tieReason?: string;
  weight: number;
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


function relativeGap(mine: number, theirs: number): number {
  const larger = Math.max(Math.abs(mine), Math.abs(theirs));
  if (larger === 0) return 0;
  return Math.min(1, Math.abs(mine - theirs) / larger);
}

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


function havingIsBetter(mine: boolean, theirs: boolean): Outcome {
  if (mine === theirs) return { verdict: "tie", separation: 0 };
  return { verdict: mine ? "win" : "lose", separation: 1 };
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");


const bothCaptured = (a: unknown, b: unknown) => a !== undefined && b !== undefined;

const capturedYesNo = (v: boolean | undefined) =>
  v === undefined ? "Not captured" : yesNo(v);

const isNoindex = (robots: string | undefined) => /noindex/.test(robots ?? "");

const indexableLabel = (robots: string | undefined) =>
  robots === undefined ? "Not captured" : isNoindex(robots) ? "Blocked" : "Yes";

/** A tie that says the data is missing rather than implying the two are equal. */
const unmeasured = (): Outcome => ({
  verdict: "tie",
  separation: 0,
  tieReason: "Not captured on one of these snapshots — refresh both to compare this.",
});


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


const METRIC_WEIGHTS: Record<string, number> = {
  score: 0,
  title: 0.13,
  description: 0.09,
  words: 0.13,
  headings: 0.07,
  schema: 0.1,
  "internal-links": 0.07,
  speed: 0.1,
  "page-weight": 0.05,
  "open-graph": 0.05,
  "alt-text": 0.07,

  indexable: 0.08,
  mobile: 0.03,
  canonical: 0.02,
  "twitter-cards": 0.01,
  "heading-depth": 0.0,
};

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

    row(
      "mobile",
      "Mobile viewport",
      capturedYesNo(mine.hasMobileViewport),
      capturedYesNo(theirs.hasMobileViewport),
      bothCaptured(mine.hasMobileViewport, theirs.hasMobileViewport)
        ? havingIsBetter(mine.hasMobileViewport!, theirs.hasMobileViewport!)
        : unmeasured(),
      "Google indexes the mobile version first. Without this tag a page is rendered at desktop width on a phone."
    ),
    row(
      "indexable",
      "Indexable",
      indexableLabel(mine.metaRobots),
      indexableLabel(theirs.metaRobots),
      bothCaptured(mine.metaRobots, theirs.metaRobots)
        ? havingIsBetter(!isNoindex(mine.metaRobots), !isNoindex(theirs.metaRobots))
        : unmeasured(),
      "A noindex directive removes the page from search entirely, whatever else it does well."
    ),
    row(
      "canonical",
      "Canonical URL",
      mine.canonical ? "Set" : "Missing",
      theirs.canonical ? "Set" : "Missing",
      havingIsBetter(Boolean(mine.canonical), Boolean(theirs.canonical)),
      "A canonical tells search engines which URL is the real one when the same page is reachable more than one way."
    ),
    row(
      "twitter-cards",
      "Twitter Card tags",
      yesNo(mine.hasTwitterCards),
      yesNo(theirs.hasTwitterCards),
      havingIsBetter(mine.hasTwitterCards, theirs.hasTwitterCards),
      "Decides how a link renders when shared on X. Without them the post shows a bare URL."
    ),
    row(
      "heading-depth",
      "Outline depth",
      String((mine.headings ?? []).length),
      String((theirs.headings ?? []).length),
      (mine.headings && theirs.headings)
        ? moreIsBetter(mine.headings.length, theirs.headings.length, 3, "headings")
        : unmeasured(),
      "The full H1–H3 outline, not just top-level sections — how thoroughly the page is structured."
    ),
  ];

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

  const mineTopics = new Set((mine.headings ?? []).map((h) => topicKey(h.text)));
  const contentGaps = (theirs.headings ?? [])
    .filter((h) => h.level === 2 || h.level === 3)
    .filter((h) => {
      const key = topicKey(h.text);
      return key.length > 3 && !mineTopics.has(key);
    })

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

  const above = [...field.slice(0, myIndex)].reverse().find((f) => f.score > myScore) ?? null;
  const below = field.slice(myIndex + 1).find((f) => f.score < myScore) ?? null;

  return {
    rank,
    fieldSize: field.length,
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
