import { alertServerError } from "./ops-alert.js";

type SentryModule = typeof import("@sentry/node");

const FLUSH_TIMEOUT_MS = 2000;

let loading: Promise<SentryModule | null> | null = null;

export function initMonitoring(): Promise<SentryModule | null> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return Promise.resolve(null);
  loading ??= import("@sentry/node")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
        release: process.env.VERCEL_GIT_COMMIT_SHA,
        sendDefaultPii: false,
        tracesSampleRate: 0,
      });
      return Sentry;
    })
    .catch((e: unknown) => {
      console.error("[monitoring] could not start Sentry:", e instanceof Error ? e.message : e);
      return null;
    });
  return loading;
}

type ErrorContext = { method: string; path: string; userId?: string };

export async function captureServerError(error: unknown, context: ErrorContext): Promise<void> {
  await Promise.all([reportToSentry(error, context), alertServerError(error, context)]);
}

async function reportToSentry(error: unknown, context: ErrorContext): Promise<void> {
  const Sentry = await initMonitoring();
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag("method", context.method);
    scope.setTag("route", context.path);
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
  await Sentry.flush(FLUSH_TIMEOUT_MS);
}
