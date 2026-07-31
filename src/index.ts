import "dotenv/config";
import app from "./app.js";
import { connectDB } from "./db.js";
import { startFxCron } from "./lib/fx-cron.js";

const PORT = process.env.PORT ?? 4000;

async function start() {
  await connectDB();
  // After the connection, never before: a tick that fires against no DB
  // fails for a reason that has nothing to do with exchange rates.
  startFxCron();
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

start().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});
