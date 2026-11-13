import { readFormsWorkspace } from "../../../infra/http-client/forms-service.js";
import { completeDays, DAY_MS, rangeFor, type DayWindow } from "../windows.js";
import type { SourceStatus } from "../types.js";
import { PAGE_DAYS, WEEK_DAYS, type SourceResult } from "./analytics.source.js";

export const FORM_DAYS = 30;
const BOOKING_LOOKBACK_DAYS = 60;
const BOOKING_LOOKAHEAD_DAYS = 60;

export type FormPerformanceRow = {
  id: string;
  title: string;
  status: "draft" | "published";
  views: number;
  responses: number;
  previousViews?: number;
  previousResponses?: number;
};

type FormsAnalyticsReply = { forms: { id: string }[]; performance: FormPerformanceRow[] };
type PipelineReply = { total: number };
type BookingReply = { byForm: { formId: string; name: string; bookings: number }[] };
export type LeadPagesReply = { total: number; withLanding: number; pages: { host: string; path: string; leads: number }[] };

export type FormsData = {
  formCount: number;
  performance: FormPerformanceRow[];
  formWindow: ReturnType<typeof rangeFor>;
  leadsWeek: { window: DayWindow; current: number; previous: number } | null;
  leadPages: { window: DayWindow; reply: LeadPagesReply } | null;
  bookingFormIds: string[];
};

export type FormsSources = {
  leadCapture: SourceResult<FormsData>;
  bookings: SourceStatus;
};

const iso = (d: Date) => d.toISOString();

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

export async function loadForms(workspaceId: string, actorId: string, now: Date): Promise<FormsSources> {
  const week = completeDays(WEEK_DAYS, now);
  const month = completeDays(PAGE_DAYS, now);
  const read = <T>(path: string, params: Record<string, string>) => readFormsWorkspace<T>(workspaceId, actorId, path, params);

  const [analytics, leadsNow, leadsBefore, pages, bookings] = await Promise.allSettled([
    read<FormsAnalyticsReply>("/analytics", { range: `${FORM_DAYS}d`, tz: "UTC" }),
    read<PipelineReply>("/pipeline-summary", { from: iso(week.since), to: iso(new Date(week.until.getTime() - 1)) }),
    read<PipelineReply>("/pipeline-summary", { from: iso(week.prevSince), to: iso(new Date(week.prevUntil.getTime() - 1)) }),
    read<LeadPagesReply>("/lead-pages", { from: iso(month.since), to: iso(new Date(month.until.getTime() - 1)) }),
    read<BookingReply>("/booking-summary", {
      from: iso(new Date(now.getTime() - BOOKING_LOOKBACK_DAYS * DAY_MS)),
      to: iso(new Date(now.getTime() + BOOKING_LOOKAHEAD_DAYS * DAY_MS)),
    }),
  ]);

  const formsReply = settled(analytics);
  if (!formsReply) {
    const failed: SourceStatus = { id: "leadCapture", state: "error", detail: "Lead capture data could not be read. It will be tried again on the next scan.", freshAt: null };
    return {
      leadCapture: { status: failed, data: null },
      bookings: { id: "bookings", state: "error", detail: "Booking data could not be read.", freshAt: null },
    };
  }

  const formCount = formsReply.forms.length;
  const leadsCurrent = settled(leadsNow);
  const leadsPrevious = settled(leadsBefore);
  const pagesReply = settled(pages);
  const bookingReply = settled(bookings);
  const bookingFormIds = (bookingReply?.byForm ?? []).filter((r) => r.bookings > 0).map((r) => r.formId);

  const leadCapture: SourceResult<FormsData> = formCount
    ? {
        status: { id: "leadCapture", state: "ready", detail: `${formCount} ${formCount === 1 ? "form" : "forms"}`, freshAt: now },
        data: {
          formCount,
          performance: formsReply.performance ?? [],
          formWindow: rangeFor(FORM_DAYS, now),
          leadsWeek:
            leadsCurrent && leadsPrevious
              ? { window: week, current: leadsCurrent.total, previous: leadsPrevious.total }
              : null,
          leadPages: pagesReply ? { window: month, reply: pagesReply } : null,
          bookingFormIds,
        },
      }
    : { status: { id: "leadCapture", state: "not_connected", detail: "No lead capture forms yet.", freshAt: null }, data: null };

  const bookingStatus: SourceStatus = !bookingReply
    ? { id: "bookings", state: "error", detail: "Booking data could not be read.", freshAt: null }
    : bookingFormIds.length
      ? { id: "bookings", state: "ready", detail: `${bookingFormIds.length} booking ${bookingFormIds.length === 1 ? "form" : "forms"}`, freshAt: now }
      : { id: "bookings", state: "not_connected", detail: "No form has taken a booking in the last 60 days.", freshAt: null };

  return { leadCapture, bookings: bookingStatus };
}
