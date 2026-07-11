import express, { Request, Response } from "express";
import cors from "cors";
import { Event } from "./models/Event.js";

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
  })
);
app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Record an event
app.post("/api/events", async (req: Request, res: Response) => {
  try {
    const { type, path, userId } = req.body ?? {};
    if (!type) return res.status(400).json({ error: "type required" });
    const event = await Event.create({ type, path, userId });
    res.status(201).json(event);
  } catch (e) {
    res.status(500).json({ error: "failed to record event" });
  }
});

// Aggregated analytics from stored events
app.get("/api/analytics", async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000); // last 5 min
    const [pageViews, activeUsers] = await Promise.all([
      Event.countDocuments({ type: "pageview" }),
      Event.distinct("userId", { createdAt: { $gte: since } }).then(
        (ids) => ids.filter(Boolean).length
      ),
    ]);
    res.json({ activeUsers, pageViews, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: "failed to load analytics" });
  }
});

export default app;
