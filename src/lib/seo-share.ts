import { readSeoPanels } from "../routes/seo.js";

/**
 * The public, read-only shape of one shared SEO audit.
 *
 * This is the single place an audit is turned into something safe to hand an
 * unauthenticated viewer: sections the owner did not publish are emitted as
 * null/empty here, on the server, so they never reach the network at all. Both
 * the per-report public route and the shared dashboard's SEO tab go through it,
 * so the two can never disagree about what a given panel choice exposes.
 *
 * Never included: the site id (it is the public tracking key), workspace id,
 * owner identity, or the raw stored report.
 */
export function publicSeoReport(
  report: NonNullable<{ get: (k: string) => unknown }>
) {
  const panels = readSeoPanels(report.get("sharePanels"));
  const data = (report.get("data") ?? {}) as Record<string, any>;

  return {
    url: report.get("url"),
    finalUrl: data.finalUrl ?? report.get("url"),
    score: report.get("score") ?? 0,
    createdAt: report.get("createdAt"),
    panels,

    performance:
      panels.summary || panels.performance
        ? sharePerformance(data.performance, panels)
        : null,

    issues: panels.issues ? data.issues ?? [] : [],

    meta: panels.meta ? data.meta ?? null : null,
    content: panels.content ? data.content ?? null : null,
    technical: panels.technical ? data.technical ?? null : null,
    siteFiles: panels.technical ? data.siteFiles ?? null : null,
    links: panels.links ? data.links ?? null : null,
    schema: panels.schema ? data.schema ?? null : null,
  };
}

/**
 * Performance is used by two panels: the summary band (just the category
 * scores) and the full performance section (metrics + suggestions). Send only
 * what the enabled panels justify.
 */
function sharePerformance(
  perf: Record<string, any> | undefined,
  panels: Record<string, boolean>
) {
  if (!perf) return null;
  const base = {
    available: Boolean(perf.available),
    scores: perf.scores ?? {
      seo: null,
      performance: null,
      accessibility: null,
      bestPractices: null,
    },
  };
  if (!panels.performance) {
    // Summary only: category rings, no metrics or opportunity list.
    return { ...base, mobile: null, desktop: null, suggestions: [] };
  }
  return {
    ...base,
    mobile: perf.mobile ?? null,
    desktop: perf.desktop ?? null,
    suggestions: perf.suggestions ?? [],
  };
}
