import { Request, Response, NextFunction } from "express";
import { isAppError } from "../../shared/errors/index.js";

/**
 * 404 for anything no router claimed.
 *
 * Mounted before the error handler so an unknown path produces the same JSON
 * shape as every other failure, rather than Express's default HTML page — a
 * client parsing our errors should never have to special-case one of them.
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
}

/**
 * The single place a failed request becomes a response.
 *
 * Two categories, deliberately treated differently. An `AppError` was thrown on
 * purpose and its message is written for the caller, so it is passed through as
 *-is. Anything else is a bug or an infrastructure failure whose message may
 * name internals — a query, a hostname, a stack path — so the caller gets a
 * fixed string and the detail goes to the log instead.
 *
 * A few driver-level failures are translated rather than buried, because they
 * are really client mistakes wearing a database error's clothes: a duplicate
 * key is a 409, a schema violation or a malformed id is a 400. Without this
 * every unique-index collision would read as "our fault" in the logs.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  // A handler that already started writing cannot be given a status or a body;
  // all that is left is to abort the stream so the client sees a broken
  // response rather than a truncated-but-plausible one.
  if (res.headersSent) return req.socket.destroy();

  if (isAppError(err)) {
    return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
  }

  const e = err as { name?: string; code?: number; message?: string; errors?: unknown };

  // CORS rejections from the dashboard allowlist in app.ts.
  if (typeof e.message === "string" && e.message.startsWith("Origin not allowed:")) {
    return res.status(403).json({ error: "origin not allowed" });
  }

  if (e.code === 11000) {
    return res.status(409).json({ error: "already exists" });
  }

  if (e.name === "ValidationError") {
    return res.status(400).json({ error: "invalid input" });
  }

  // A malformed ObjectId in the path: the caller asked for something that
  // cannot exist, which is a bad request, not a server fault.
  if (e.name === "CastError") {
    return res.status(400).json({ error: "invalid id" });
  }

  // Body parser failures (bad JSON, oversized payload) arrive here too.
  if (e.name === "SyntaxError" && "body" in (e as object)) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if ((e as { type?: string }).type === "entity.too.large") {
    return res.status(413).json({ error: "payload too large" });
  }

  console.error(`unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "internal server error" });
}
