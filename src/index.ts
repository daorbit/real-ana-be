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
  // been written yet. Flush on the way out. SIGUSR2 is included for `tsx watch`
  // and nodemon, which restart with that rather than SIGTERM — without it every
  // hot reload in development silently discards the buffer.
  for (const signal of ["SIGTERM", "SIGINT", "SIGUSR2"] as const) {
    process.once(signal, () => {
      flushEventUsage()
        .catch((e) => console.error("[event-quota] final flush failed:", e))
        .finally(() => {
          // Re-raise rather than `process.exit(0)`. The handler's only job is to
          // get the buffer written; deciding what the signal *means* belongs to
          // whoever sent it. Exiting zero on SIGUSR2 would swallow a watcher's
          // restart, and on SIGTERM it would report a clean exit for what may
          // have been a kill.
          process.removeAllListeners(signal);
          process.kill(process.pid, signal);
        });
    });
  }
}

start().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});
