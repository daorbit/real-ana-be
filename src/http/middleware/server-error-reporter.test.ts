import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import {
  createServerErrorReporter,
  markServerErrorReported,
  messageOf,
  type ServerErrorReport,
} from "./server-error-reporter.js";

type Captured = { status: number; report: ServerErrorReport };

const WID = "66f1a2b3c4d5e6f708192a3b";
const SETTLE_MS = 30;

let captured: Captured[] = [];
let server: Server;
let base: string;

function buildApp() {
  const app = express();
  app.use(createServerErrorReporter((status, report) => captured.push({ status, report })));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.get("x-test-user");
    if (userId) (req as Request & { userId?: string }).userId = userId;
    next();
  });

  const reviews = Router();
  reviews.post("/sync", (_req, res) => {
    res.status(502).json({ error: "Google returned 403" });
  });
  app.use("/api/workspaces/:wid/reviews", reviews);

  app.get("/ok", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/not-found", (_req, res) => {
    res.status(404).json({ error: "missing" });
  });
  app.get("/handled", (_req, res) => {
    markServerErrorReported(res);
    res.status(500).json({ error: "already reported" });
  });
  app.get("/text", (_req, res) => {
    res.status(503).send("push is not configured");
  });
  app.get("/html", (_req, res) => {
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  });
  app.get("/oauth", (_req, res) => {
    res.status(500).json({ error: "server_error", error_description: "unexpected error" });
  });
  app.get("/empty", (_req, res) => {
    res.status(500).end();
  });
  app.use((_req: Request, res: Response) => {
    res.status(500).json({ error: "no route matched" });
  });
  return app;
}

async function call(path: string, init: RequestInit = {}): Promise<number> {
  const response = await fetch(`${base}${path}`, init);
  await response.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return response.status;
}

before(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  captured = [];
});

describe("createServerErrorReporter", () => {
  test("reports a 5xx with the route, error, user, timing and request id", async () => {
    const status = await call(`/api/workspaces/${WID}/reviews/sync?force=1`, {
      method: "POST",
      headers: { "x-test-user": "user-1", "x-vercel-id": "bom1::abc12" },
    });
    assert.equal(status, 502);
    assert.equal(captured.length, 1);
    const [{ status: reported, report }] = captured;
    assert.equal(reported, 502);
    assert.equal(report.method, "POST");
    assert.equal(report.path, `/api/workspaces/${WID}/reviews/sync?force=1`);
    assert.equal(report.route, `/api/workspaces/${WID}/reviews/sync`);
    assert.equal(report.message, "Google returned 403");
    assert.equal(report.userId, "user-1");
    assert.equal(report.requestId, "bom1::abc12");
    assert.equal(typeof report.durationMs, "number");
    assert.ok(report.durationMs >= 0);
  });

  test("ignores successful and client-error responses", async () => {
    assert.equal(await call("/ok"), 200);
    assert.equal(await call("/not-found"), 404);
    assert.equal(captured.length, 0);
  });

  test("skips responses already reported elsewhere", async () => {
    assert.equal(await call("/handled"), 500);
    assert.equal(captured.length, 0);
  });

  test("uses a plain-text body as the message", async () => {
    await call("/text");
    assert.equal(captured[0].status, 503);
    assert.equal(captured[0].report.message, "push is not configured");
    assert.equal(captured[0].report.route, "/text");
  });

  test("does not use an HTML page as the message", async () => {
    await call("/html");
    assert.equal(captured[0].report.message, undefined);
    assert.equal(captured[0].report.route, "/html");
  });

  test("joins OAuth style error fields", async () => {
    await call("/oauth");
    assert.equal(captured[0].report.message, "server_error: unexpected error");
  });

  test("still reports an empty 5xx response", async () => {
    await call("/empty");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].report.message, undefined);
    assert.equal(captured[0].report.route, undefined);
  });

  test("leaves the route empty when no route matched", async () => {
    await call("/nowhere");
    assert.equal(captured[0].report.route, undefined);
    assert.equal(captured[0].report.message, "no route matched");
    assert.equal(captured[0].report.userId, undefined);
    assert.equal(captured[0].report.requestId, undefined);
  });

  test("reports each failing request once", async () => {
    await call("/text");
    await call("/text");
    assert.equal(captured.length, 2);
  });
});

describe("messageOf", () => {
  test("reads error, message and error_description in order", () => {
    assert.equal(messageOf({ error: "a", message: "b", error_description: "c" }), "a: b: c");
    assert.equal(messageOf({ message: "only message" }), "only message");
  });

  test("ignores empty and non-string parts", () => {
    assert.equal(messageOf({ error: "", message: 42 }), undefined);
    assert.equal(messageOf({ error: { nested: true }, message: "kept" }), "kept");
  });

  test("trims and bounds plain text", () => {
    assert.equal(messageOf("  hello  "), "hello");
    assert.equal(messageOf("   "), undefined);
    assert.equal(messageOf("x".repeat(900))?.length, 500);
  });

  test("returns undefined for other values", () => {
    assert.equal(messageOf(undefined), undefined);
    assert.equal(messageOf(null), undefined);
    assert.equal(messageOf(42), undefined);
  });
});
