import { Request, Response, NextFunction } from "express";
import { isAppError } from "../../shared/errors/index.js";


export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
}


export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {

  if (res.headersSent) return req.socket.destroy();

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
  res.status(500).json({ error: "internal server error" });
}
