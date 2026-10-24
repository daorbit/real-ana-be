import { Request, Response, NextFunction } from "express";
import { isAppError } from "../../shared/errors/index.js";
import { captureServerError } from "../../infra/monitoring/sentry.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";
import type { AuthedRequest } from "./auth.js";
import { markServerErrorReported } from "./report-server-errors.js";

function reportAfterResponse(err: unknown, req: Request, res: Response): void {
  markServerErrorReported(res);
  const context = { method: req.method, path: req.path, userId: (req as AuthedRequest).userId };
  runAfterResponse("error report", () => captureServerError(err, context));
}


export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
}


export async function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {

  if (res.headersSent) {
    reportAfterResponse(err, req, res);
    return req.socket.destroy();
  }

  if (isAppError(err)) {
    return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
  }

  const e = err as { name?: string; code?: number; message?: string; errors?: unknown };

  if (typeof e.message === "string" && e.message.startsWith("Origin not allowed:")) {
    return res.status(403).json({ error: "origin not allowed" });
  }

  if (e.code === 11000) {
    return res.status(409).json({ error: "already exists" });
  }

  if (e.name === "ValidationError") {
    return res.status(400).json({ error: "invalid input" });
  }

  if (e.name === "CastError") {
    return res.status(400).json({ error: "invalid id" });
  }

  if (e.name === "SyntaxError" && "body" in (e as object)) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if ((e as { type?: string }).type === "entity.too.large") {
    return res.status(413).json({ error: "payload too large" });
  }

  console.error(`unhandled error on ${req.method} ${req.originalUrl}:`, err);
  reportAfterResponse(err, req, res);
  res.status(500).json({ error: "internal server error" });
}
