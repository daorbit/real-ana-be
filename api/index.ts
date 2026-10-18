import "dotenv/config";
import app from "../src/app.js";
import { connectDB } from "../src/infra/db/connection.js";
import { captureServerError } from "../src/infra/monitoring/sentry.js";
import { installProcessGuards } from "../src/infra/monitoring/process-guards.js";

installProcessGuards();

export default async function handler(req: any, res: any) {
  try {
    await connectDB();
  } catch (e) {
    console.error("[db] connection failed:", e);
    await captureServerError(e, { method: req.method ?? "", path: req.url ?? "" }).catch(() => {});
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Retry-After", "5");
    res.end(JSON.stringify({ error: "service temporarily unavailable" }));
    return;
  }
  return app(req, res);
}
