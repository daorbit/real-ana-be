import type { Request, Response, NextFunction } from "express";
import { alertServerResponse } from "../../infra/monitoring/ops-alert.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";
import type { AuthedRequest } from "./auth.js";

const REPORTED = "serverErrorReported";
const MESSAGE = "serverErrorMessage";
const ROUTE = "serverErrorRoute";

export function markServerErrorReported(res: Response): void {
  res.locals[REPORTED] = true;
}

function messageOf(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, 500) || undefined;
  if (!body || typeof body !== "object") return undefined;
  const { error, message, error_description } = body as Record<string, unknown>;
  const parts = [error, message, error_description].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length ? parts.join(": ") : undefined;
}

function matchedRoute(req: Request): string | undefined {
  if (!req.route) return undefined;
  return `${req.baseUrl}${String(req.route.path)}`;
}

export function reportServerErrors(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();

  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode >= 500) {
      res.locals[MESSAGE] = messageOf(body);
      res.locals[ROUTE] = matchedRoute(req);
    }
    return json(body);
  }) as Response["json"];

  const send = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (res.statusCode >= 500) {
      res.locals[MESSAGE] ??= typeof body === "string" && !body.startsWith("<") ? messageOf(body) : undefined;
      res.locals[ROUTE] ??= matchedRoute(req);
    }
    return send(body);
  }) as Response["send"];

  res.on("finish", () => {
    if (res.statusCode < 500 || res.locals[REPORTED]) return;
    const context = {
      method: req.method,
      path: req.originalUrl,
      route: res.locals[ROUTE] as string | undefined,
      message: res.locals[MESSAGE] as string | undefined,
      userId: (req as AuthedRequest).userId,
      durationMs: Date.now() - started,
      requestId: req.get("x-vercel-id") ?? undefined,
    };
    runAfterResponse("server error alert", () => alertServerResponse(res.statusCode, context));
  });

  next();
}
