import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AppSetting, SETTING_DB_CONNECTIONS } from "../../config/AppSetting.js";
import { encryptSecret, readStoredSecret } from "../../shared/utils/crypto-box.js";
import { AppError } from "../../shared/errors/index.js";
import { DEFAULT_DB_LIMIT_BYTES, readDbStorage, type DbStorageStats, type MongoDb } from "./db-stats.service.js";

type StoredConnection = {
  id: string;
  label: string;
  uri: string;
  host: string;
  dbName: string;
  limit: number;
  createdAt: string;
};

export type DbConnectionView = Omit<StoredConnection, "uri">;

const MAX_CONNECTIONS = 10;
const CONNECT_TIMEOUT_MS = 8000;
const MB = 1024 * 1024;
const MAX_LIMIT_MB = 1024 * 1024;
const URI_RE = /^mongodb(\+srv)?:\/\//i;
const DB_NAME_RE = /^[^/\\. "$*<>:|?]{1,63}$/;

async function loadAll(): Promise<StoredConnection[]> {
  const row = await AppSetting.findOne({ key: SETTING_DB_CONNECTIONS }).select("value").lean();
  return Array.isArray(row?.value) ? (row.value as StoredConnection[]) : [];
}

async function saveAll(list: StoredConnection[]): Promise<void> {
  await AppSetting.updateOne({ key: SETTING_DB_CONNECTIONS }, { $set: { value: list } }, { upsert: true });
}

function toView(c: StoredConnection): DbConnectionView {
  return { id: c.id, label: c.label, host: c.host, dbName: c.dbName, limit: c.limit, createdAt: c.createdAt };
}

function describeUri(uri: string): { host: string; dbName: string } {
  const rest = uri.replace(URI_RE, "");
  const authority = rest.split(/[/?]/)[0];
  const hosts = authority.slice(authority.lastIndexOf("@") + 1);
  const path = rest.slice(authority.length).split("?")[0].replace(/^\//, "");
  let dbName = path;
  try {
    dbName = decodeURIComponent(path);
  } catch {
    dbName = path;
  }
  return { host: hosts.split(",")[0], dbName };
}

function connectError(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  if (/not authorized|Unauthorized/i.test(message)) return "Connected, but this user can't read database stats";
  if (/auth|credential|password/i.test(message)) return "MongoDB refused that username or password";
  if (/ENOTFOUND|querySrv|EAI_AGAIN/i.test(message)) return "Could not find that MongoDB host";
  if (/timed out|Server selection|ECONNREFUSED/i.test(message)) {
    return "MongoDB did not answer. Check the host and the cluster's network access list";
  }
  return "Could not connect to that database";
}

async function withDb<T>(uri: string, dbName: string, run: (db: MongoDb) => Promise<T>): Promise<T> {
  const conn = mongoose.createConnection(uri, {
    dbName: dbName || undefined,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    maxPoolSize: 1,
    autoIndex: false,
    autoCreate: false,
  });
  try {
    await conn.asPromise();
    if (!conn.db) throw new AppError(422, "Connected, but no database was selected");
    return await run(conn.db);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(422, connectError(e));
  } finally {
    await conn.close().catch(() => undefined);
  }
}

function parseInput(body: Record<string, unknown>) {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const uri = typeof body.uri === "string" ? body.uri.trim() : "";
  const dbNameInput = typeof body.dbName === "string" ? body.dbName.trim() : "";
  const limitMb = body.limitMb === undefined || body.limitMb === null ? DEFAULT_DB_LIMIT_BYTES / MB : Number(body.limitMb);

  if (!label || label.length > 40) throw new AppError(400, "Give the database a name of up to 40 characters");
  if (!URI_RE.test(uri)) throw new AppError(400, "Paste a connection string that starts with mongodb:// or mongodb+srv://");
  if (dbNameInput && !DB_NAME_RE.test(dbNameInput)) throw new AppError(400, "That database name is not valid");
  if (!Number.isFinite(limitMb) || limitMb < 1 || limitMb > MAX_LIMIT_MB) {
    throw new AppError(400, "The storage limit must be between 1 MB and 1 TB");
  }

  const described = describeUri(uri);
  return {
    label,
    uri,
    host: described.host,
    dbName: dbNameInput || described.dbName,
    limit: Math.round(limitMb * MB),
  };
}

export async function listDbConnections(): Promise<DbConnectionView[]> {
  return (await loadAll()).map(toView);
}

export async function addDbConnection(body: Record<string, unknown>): Promise<DbConnectionView> {
  const input = parseInput(body);
  const current = await loadAll();
  if (current.length >= MAX_CONNECTIONS) throw new AppError(400, `You can add up to ${MAX_CONNECTIONS} databases`);

  const stats = await withDb(input.uri, input.dbName, (db) => readDbStorage(db, input.limit));

  const saved: StoredConnection = {
    id: randomUUID(),
    label: input.label,
    uri: encryptSecret(input.uri),
    host: input.host,
    dbName: input.dbName || stats.name,
    limit: input.limit,
    createdAt: new Date().toISOString(),
  };
  await saveAll([...current, saved]);
  return toView(saved);
}

export async function removeDbConnection(id: string): Promise<void> {
  const current = await loadAll();
  const next = current.filter((c) => c.id !== id);
  if (next.length === current.length) throw new AppError(404, "That database is not saved");
  await saveAll(next);
}

export async function dbConnectionStats(id: string): Promise<DbStorageStats> {
  const saved = (await loadAll()).find((c) => c.id === id);
  if (!saved) throw new AppError(404, "That database is not saved");

  const secret = readStoredSecret(saved.uri);
  if (!secret.ok) throw new AppError(409, "The saved connection string can't be read. Remove it and add it again");

  return withDb(secret.value, saved.dbName, (db) => readDbStorage(db, saved.limit));
}
