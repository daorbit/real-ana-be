import "dotenv/config";
import app from "./app.js";
import { connectDB } from "./infra/db/connection.js";
import { startFxCron } from "./modules/billing/fx-cron.js";
import { startEventUsageFlush, flushEventUsage } from "./modules/billing/event-quota.js";

const PORT = process.env.PORT ?? 4000;

async function start() {
  await connectDB();
  // After the connection, never before: a tick that fires against no DB
  // fails for a reason that has nothing to do with exchange rates.
  startFxCron();
  // Periodic write-back of buffered event counts. Only useful on a host whose
  // process outlives a request — on Vercel the flush happens from the ingest
  // path instead, because a frozen function's timers never fire.
  startEventUsageFlush();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });

  // Buffered usage lives in memory, so a restart would drop whatever has not
  // been written yet. Flush on the way out.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      flushEventUsage()
        .catch((e) => console.error("[event-quota] final flush failed:", e))
        .finally(() => process.exit(0));
    });
  }
}

start().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});
