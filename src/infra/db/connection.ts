import mongoose from "mongoose";

/**
 * A connection string with no database in its path silently falls back to
 * MongoDB's default database, `test` — which is how prod and local ended up
 * writing to two different databases. Pin the name explicitly instead.
 */
const DB_NAME = process.env.MONGODB_DB ?? "realana";

/**
 * The in-flight connection attempt, so concurrent callers share one.
 *
 * Held rather than a boolean "connected" flag, which is the trap this used to
 * fall into: a module-level flag records that we *once* connected, and on a
 * serverless host that is not the same question as whether we are connected
 * *now*. Containers are frozen between requests and the socket can be gone when
 * one thaws, leaving the flag true and every query buffering against a dead
 * connection until it times out — surfacing far from here as an unexplained
 * write failure.
 *
 * `mongoose.connection.readyState` is the authority instead; this only avoids
 * starting a second dial while the first is still ringing.
 */
let pending: Promise<unknown> | null = null;

/** Mongoose's readyState for "connected". */
const CONNECTED = 1;
const CONNECTING = 2;

const MAX_POOL_SIZE = 15;
const POOL_WAIT_LIMIT_MS = 20_000;
const IDLE_CONNECTION_LIMIT_MS = 60_000;
const QUERY_TIME_LIMIT_MS = 25_000;

export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState === CONNECTED) return;

  // Already dialling — from this request or another sharing the container.
  if (pending && mongoose.connection.readyState === CONNECTING) {
    await pending;
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  // `dbName` overrides whatever is (or isn't) in the URI path, so the same
  // secret works whether or not it happens to carry a database name.
  //
  // `bufferCommands: false` makes a query on a dead connection fail at once
  // rather than queueing for ten seconds and then throwing a timeout that says
  // nothing about the real cause.
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) mongoose.set("maxTimeMS", QUERY_TIME_LIMIT_MS);

  pending = mongoose.connect(uri, {
    dbName: DB_NAME,
    bufferCommands: false,
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: MAX_POOL_SIZE,
    waitQueueTimeoutMS: POOL_WAIT_LIMIT_MS,
    maxIdleTimeMS: IDLE_CONNECTION_LIMIT_MS,
    autoIndex: !isProduction,
    autoCreate: !isProduction,
  });

  try {
    await pending;
    console.log(`MongoDB connected — database "${mongoose.connection.name}"`);
  } finally {
    pending = null;
  }
}
