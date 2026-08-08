/**
 * The error type every route is allowed to throw.
 *
 * A thrown `AppError` is a deliberate, client-visible outcome: the status and
 * message are exactly what the caller receives. Anything else that escapes a
 * handler is a bug, and the error middleware turns it into a bare 500 without
 * leaking its message — that distinction is the whole reason this class exists
 * rather than throwing plain `Error` with a status stapled on.
 */
export class AppError extends Error {
  readonly status: number;
  /** Extra fields merged into the JSON body, for clients that key off them. */
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }
}

/** 400 — the request itself is malformed or missing something required. */
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, message, details);

/** 401 — no usable credential was presented. */
export const unauthorized = (message = "unauthorized") => new AppError(401, message);

/** 403 — credential understood, but it does not permit this. */
export const forbidden = (message = "forbidden", details?: Record<string, unknown>) =>
  new AppError(403, message, details);

/** 404 — no such resource, or none the caller is allowed to know about. */
export const notFound = (message = "not found") => new AppError(404, message);

/** 409 — the request conflicts with the current state (duplicates, races). */
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(409, message, details);

/** 402 — the action is real but the workspace's plan does not cover it. */
export const paymentRequired = (message: string, details?: Record<string, unknown>) =>
  new AppError(402, message, details);

/** 429 — the caller is over a rate or quota limit. */
export const tooManyRequests = (message = "too many requests", details?: Record<string, unknown>) =>
  new AppError(429, message, details);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
