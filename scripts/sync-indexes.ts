import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import "../src/app.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  let missing = 0;
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const { toCreate } = await model.diffIndexes();
    if (!toCreate.length) continue;

    missing += toCreate.length;
    console.log(`${name}: ${toCreate.length} missing index(es)`, JSON.stringify(toCreate));
    if (WRITE) await model.createIndexes();
  }

  console.log(`${missing} index(es) missing across ${mongoose.modelNames().length} models.`);
  if (!WRITE) console.log("\nDry run. Re-run with --write to create them. Nothing is ever dropped.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
