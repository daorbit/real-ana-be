import mongoose from "mongoose";

let connected = false;

/**
 * A connection string with no database in its path silently falls back to
 * MongoDB's default database, `test` — which is how prod and local ended up
 * writing to two different databases. Pin the name explicitly instead.
 */
const DB_NAME = process.env.MONGODB_DB ?? "realana";

export async function connectDB(): Promise<void> {
  if (connected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  // `dbName` overrides whatever is (or isn't) in the URI path, so the same
  // secret works whether or not it happens to carry a database name.
  await mongoose.connect(uri, { dbName: DB_NAME });

  connected = true;
  console.log(`MongoDB connected — database "${mongoose.connection.name}"`);
}
