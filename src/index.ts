import express, { Request, Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/analytics", (_req: Request, res: Response) => {
  res.json({
    activeUsers: Math.floor(Math.random() * 500),
    pageViews: Math.floor(Math.random() * 5000),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
