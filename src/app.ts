import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import workspaceRoutes from "./routes/workspaces.js";
import collectRoutes from "./routes/collect.js";
import statsRoutes from "./routes/stats.js";

const app = express();
app.use(express.json());

const dashboardOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
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

// Dashboard API (restricted origin + JWT inside route modules)
app.use("/api/auth", dashboardCors, authRoutes);
app.use("/api/workspaces", dashboardCors, workspaceRoutes);
app.use("/api/sites", dashboardCors, statsRoutes);

export default app;
