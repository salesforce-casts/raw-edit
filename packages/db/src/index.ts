import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

type Database = ReturnType<typeof drizzlePostgres> | ReturnType<typeof drizzleNeon>;

const globalForDb = globalThis as unknown as {
  rawEditDb?: Database;
  rawEditSql?: ReturnType<typeof postgres>;
};

export function getDb(databaseUrl = process.env.DATABASE_URL): Database {
  if (!databaseUrl) {
    return new Proxy({} as Database, {
      get() {
        throw new Error("DATABASE_URL is required at runtime");
      },
    });
  }
  if (globalForDb.rawEditDb) return globalForDb.rawEditDb;

  const useNeonHttp =
    process.env.DATABASE_DRIVER === "neon-http" ||
    (Boolean(process.env.VERCEL) && process.env.DATABASE_DRIVER !== "postgres");

  if (useNeonHttp) {
    const db = drizzleNeon({ client: neon(databaseUrl), schema });
    globalForDb.rawEditDb = db;
    return db;
  }

  const sql =
    globalForDb.rawEditSql ??
    postgres(databaseUrl, {
      max: process.env.SERVICE_NAME === "worker" ? 4 : 8,
      prepare: false,
    });
  globalForDb.rawEditSql = sql;
  const db = drizzlePostgres(sql, { schema });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.rawEditDb = db;
  }
  return db;
}

export type RawEditDb = ReturnType<typeof getDb>;
