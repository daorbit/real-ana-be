import type { NextFunction, Response } from "express";
import { isValidObjectId } from "mongoose";
import type { AuthedRequest } from "./auth.js";
import { recordAudit } from "../../modules/audit/audit.service.js";
import { matchRoute, SKIPPED_PREFIXES } from "../../modules/audit/route-registry.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WRITE_TIMEOUT_MS = 1500;

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : null;
}

function labelOf(value: unknown): string | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  for (const key of ["name", "label", "title", "domain", "url"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
  }
  return undefined;
}

function idOf(value: unknown): string | undefined {
  const obj = asObject(value);
  const id = obj?.id ?? obj?._id;
  return id ? String(id) : undefined;
}

function routeShape(path: string): string {
  return path
    .split("/")
    .map((part) => (isValidObjectId(part) || /^[A-Za-z0-9_-]{12,}$/.test(part) ? ":id" : part))
    .join("/");
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export function auditTrail(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();

  const path = req.path;
  if (path === "/" || path === "") return next();
  if (SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();

  const workspaceId = req.params.wid;
  if (!isValidObjectId(workspaceId)) return next();

  const matched = matchRoute(req.method, path);
  if (matched && !matched.rule.action) return next();

  const snapshot = matched?.rule.snapshot
    ? matched.rule.snapshot(workspaceId, matched.params).catch(() => undefined)
    : Promise.resolve(undefined);

  void snapshot.then((before) => {
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      res.locals.auditBody = body;
      return json(body);
    }) as Response["json"];

    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    let flushed = false;

    res.end = ((...args: unknown[]) => {
      if (flushed) return end(...args);
      flushed = true;

      if (res.statusCode >= 400 || res.locals.audited || req.isDemo || !req.userId) return end(...args);

      const rule = matched?.rule;
      const body = res.locals.auditBody;
      const requestBody = asObject(req.body) ?? {};

      const write = recordAudit(req, {
        action: rule?.action ?? "workspace.changed",
        workspaceId,
        target: {
          kind: rule?.kind ?? "workspace",
          id: matched?.params.id ?? idOf(body) ?? "",
          label: before ?? labelOf(body) ?? labelOf(requestBody) ?? "",
        },
        meta: rule
          ? rule.meta?.(requestBody)
          : { method: req.method, route: routeShape(path) },
      });

      void withTimeout(write, WRITE_TIMEOUT_MS).finally(() => end(...args));
      return res;
    }) as Response["end"];

    next();
  });
}
