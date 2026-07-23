import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import workspaceRoutes from "./routes/workspaces.js";
import collectRoutes from "./routes/collect.js";
import statsRoutes from "./routes/stats.js";
import v1Routes from "./routes/v1.js";
import adminRoutes from "./routes/admin.js";
import shareRoutes from "./routes/share.js";
import seoRoutes from "./routes/seo.js";

const app = express();
app.use(express.json());
// The tracker sends beacons as text/plain (an application/json beacon would
// trigger a CORS preflight, which sendBeacon cannot perform). Parse those too.
app.use(express.text({ type: ["text/plain", "text/*"] }));

const dashboardOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
  "https://studio-quantalog.daorbit.in",
];

// Dashboard CORS: restricted to our own frontend
const dashboardCors = cors({
  origin: (origin, cb) => {
    if (!origin || dashboardOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
});

// Open CORS: tracker + collect run on arbitrary customer domains
const openCors = cors({ origin: "*" });

app.get("/api/health", dashboardCors, (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Public tracking surface (any origin)
app.use("/api/collect", openCors, collectRoutes);

// Serve embeddable tracker.js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
app.get("/tracker.js", openCors, (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(publicDir, "tracker.js"));
});

// Platform API (server-to-server, API-key auth, any origin)
app.use("/v1", openCors, v1Routes);

// Public shared dashboards. Unauthenticated by design — the share token in the
// path is the credential — so it sits outside the dashboard CORS allowlist:
// the whole point is that anyone with the link can open it from anywhere.
app.use("/api/share", openCors, shareRoutes);

// Dashboard API (restricted origin + JWT inside route modules)
app.use("/api/auth", dashboardCors, authRoutes);
app.use("/api/workspaces", dashboardCors, workspaceRoutes);
// SEO audits hang off the same prefix; kept in their own router so the
// workspace module stays about workspaces.
app.use("/api/workspaces", dashboardCors, seoRoutes);
app.use("/api/sites", dashboardCors, statsRoutes);
app.use("/api/admin", dashboardCors, adminRoutes);

export default app;
