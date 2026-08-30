import "dotenv/config";
import app from "./app.js";
import { connectDB } from "./infra/db/connection.js";
import { startFxCron } from "./modules/billing/fx-cron.js";

const PORT = process.env.PORT ?? 4000;

async function start() {
  await connectDB();
  // After the connection, never before: a tick that fires against no DB
  // fails for a reason that has nothing to do with exchange rates.
  startFxCron();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });

  // No usage buffer to drain on the way out any more: each ingest writes its
  // own count before responding, so there is never anything held in memory that
  // a restart could lose.
}

start().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});
