import { clip, MAX_ANSWERS, MAX_FIELDS, MAX_OPTIONS, TOP_N } from "./limits.js";

type Raw = Record<string, unknown>;

type RawField = {
  id: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  columns?: RawField[][];
  subFields?: RawField[];
};

const LAYOUT_TYPES = new Set([
  "heading",
  "description",
  "richText",
  "divider",
  "spacer",
  "pageBreak",
  "image",
  "loader",
  "countdown",
]);
const FILE_TYPES = new Set(["file", "imageUpload", "mediaUpload"]);

function idOf(doc: Raw): string {
  return String(doc._id ?? doc.id ?? "");
}

export function flattenFields(fields: RawField[] = []): RawField[] {
  return fields.flatMap((field) => {
    if (field.type === "grid") return flattenFields((field.columns ?? []).flat());
    if (field.type === "repeater") return [field, ...flattenFields(field.subFields ?? [])];
    return [field];
  });
}

export function presentFormSummary(form: Raw) {
  return {
    id: idOf(form),
    name: clip(form.name, 120),
    title: clip(form.title, 200),
    status: form.status,
    submissionCount: form.submissionCount ?? 0,
    viewCount: form.viewCount ?? 0,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

type FormAnalytics = {
  viewCount?: number;
  submissionCount?: number;
  completionRate?: number;
  sources?: { source: string; count: number; won: number }[];
  daily?: unknown[];
  partialsEnabled?: boolean;
};

export function presentFormDetails(form: Raw, analytics: FormAnalytics | null) {
  const fields = flattenFields((form.fields as RawField[]) ?? []).filter((f) => !LAYOUT_TYPES.has(f.type));
  return {
    ...presentFormSummary(form),
    description: clip(form.description, 1000),
    questionCount: fields.length,
    questions: fields.slice(0, MAX_FIELDS).map((f) => ({
      id: f.id,
      type: f.type,
      label: clip(f.label, 200),
      required: Boolean(f.required),
      ...(f.options?.length ? { options: f.options.slice(0, MAX_OPTIONS).map((o) => clip(o, 100)) } : {}),
    })),
    analytics: analytics
      ? {
          views: analytics.viewCount ?? 0,
          responses: analytics.submissionCount ?? 0,
          completionRatePct: Math.round((analytics.completionRate ?? 0) * 1000) / 10,
          topSources: (analytics.sources ?? []).slice(0, TOP_N),
          last14Days: analytics.daily ?? [],
          abandonmentTracked: Boolean(analytics.partialsEnabled),
        }
      : null,
  };
}

function presentAnswer(field: RawField | undefined, value: unknown): string {
  if (field?.type === "signature") return "[signature captured]";
  if (field && FILE_TYPES.has(field.type)) return value ? "[file uploaded]" : "";
  return clip(value);
}

export function presentSubmission(submission: Raw, fieldsById: Map<string, RawField>) {
  const data = (submission.data ?? {}) as Record<string, unknown>;
  const answers = Object.entries(data)
    .filter(([fieldId]) => fieldsById.get(fieldId)?.type !== "payment")
    .slice(0, MAX_ANSWERS)
    .map(([fieldId, value]) => {
      const field = fieldsById.get(fieldId);
      return { question: clip(field?.label || fieldId, 200), answer: presentAnswer(field, value) };
    })
    .filter((a) => a.answer !== "");

  const attribution = submission.attribution as Raw | undefined;
  const payment = submission.payment as Raw | undefined;
  const booking = submission.booking as Raw | undefined;
  const quiz = submission.quiz as Raw | undefined;

  return {
    id: idOf(submission),
    submittedAt: submission.createdAt,
    stage: submission.stage ?? "new",
    leadScore: submission.leadScore ?? null,
    tags: ((submission.tags as string[]) ?? []).slice(0, 20),
    read: Boolean(submission.read),
    starred: Boolean(submission.starred),
    ...(attribution
      ? {
          source: {
            channel: attribution.channel,
            source: attribution.source,
            medium: attribution.medium,
            campaign: attribution.campaign,
          },
        }
      : {}),
    ...(payment ? { payment: { status: payment.status, amountMinor: payment.amount, currency: payment.currency } } : {}),
    ...(booking ? { booking: { start: booking.start, end: booking.end, timezone: booking.timezone } } : {}),
    ...(quiz ? { quiz: { score: quiz.score, total: quiz.total } } : {}),
    answers,
  };
}

type Row = { key: string; count: number };

export function topRows(rows: unknown): Row[] {
  return ((rows as Row[]) ?? []).filter((r) => r?.key).slice(0, TOP_N);
}

type TrafficTotals = {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounceRate: number;
  avgSessionMs: number;
  pagesPerSession: number;
};

type TrafficStats = TrafficTotals & {
  live: number;
  comparison: TrafficTotals & { since: Date; until: Date };
  timeseries: { bucket: string; views: number; visitors: number }[];
  topPages: unknown;
  entryPages: unknown;
  topReferrers: unknown;
  channels: unknown;
  utmSources: unknown;
  countries: unknown;
  devices: unknown;
  browsers: unknown;
};

function changePct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function presentTotals(t: TrafficTotals) {
  return {
    visitors: t.visitors,
    pageviews: t.pageviews,
    sessions: t.sessions,
    bounceRatePct: t.bounceRate,
    avgSessionSeconds: Math.round((t.avgSessionMs ?? 0) / 1000),
    pagesPerSession: Math.round((t.pagesPerSession ?? 0) * 10) / 10,
  };
}

export function presentTraffic(stats: TrafficStats, window: { since: Date; until: Date }, hourly: boolean) {
  const prev = stats.comparison;
  return {
    window: { since: window.since, until: window.until },
    totals: presentTotals(stats),
    previousPeriod: { since: prev.since, until: prev.until, ...presentTotals(prev) },
    changeVsPreviousPct: {
      visitors: changePct(stats.visitors, prev.visitors),
      pageviews: changePct(stats.pageviews, prev.pageviews),
      sessions: changePct(stats.sessions, prev.sessions),
    },
    onlineNow: stats.live,
    trend: {
      bucket: hourly ? "hour (UTC)" : "day (UTC)",
      points: (stats.timeseries ?? []).map((p) => ({ period: p.bucket, pageviews: p.views, visitors: p.visitors })),
    },
    topPagesByPageviews: topRows(stats.topPages),
    entryPagesBySessions: topRows(stats.entryPages),
    referrersBySessions: topRows(stats.topReferrers),
    channelsBySessions: topRows(stats.channels),
    utmSourcesBySessions: topRows(stats.utmSources),
    countriesByPageviews: topRows(stats.countries),
    devicesByPageviews: topRows(stats.devices),
    browsersByPageviews: topRows(stats.browsers),
  };
}
