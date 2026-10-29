import type { Connection } from "mongoose";

export type MongoDb = NonNullable<Connection["db"]>;

export type CollectionStat = {
  name: string;
  count: number;
  dataSize: number;
  storageSize: number;
  indexSize: number;
};

export type DbStorageStats = {
  name: string;
  collections: number;
  objects: number;
  dataSize: number;
  storageSize: number;
  indexSize: number;
  used: number;
  limit: number;
  collectionStats: CollectionStat[];
};

export const DEFAULT_DB_LIMIT_BYTES = 512 * 1024 * 1024;

async function collectionStat(db: MongoDb, name: string): Promise<CollectionStat> {
  try {
    const cs = await db.command({ collStats: name });
    return {
      name,
      count: cs.count ?? 0,
      dataSize: cs.size ?? 0,
      storageSize: cs.storageSize ?? 0,
      indexSize: cs.totalIndexSize ?? 0,
    };
  } catch {
    return { name, count: 0, dataSize: 0, storageSize: 0, indexSize: 0 };
  }
}

export async function readDbStorage(db: MongoDb, limit: number): Promise<DbStorageStats> {
  const [stats, cols] = await Promise.all([
    db.command({ dbStats: 1 }),
    db.listCollections({}, { nameOnly: true }).toArray(),
  ]);

  const collections = await Promise.all(cols.map((c) => collectionStat(db, c.name)));
  collections.sort((a, b) => b.storageSize + b.indexSize - (a.storageSize + a.indexSize));

  const storageSize = stats.storageSize ?? 0;
  const indexSize = stats.indexSize ?? 0;

  return {
    name: stats.db,
    collections: stats.collections ?? collections.length,
    objects: stats.objects ?? 0,
    dataSize: stats.dataSize ?? 0,
    storageSize,
    indexSize,
    used: stats.totalSize ?? storageSize + indexSize,
    limit,
    collectionStats: collections,
  };
}
