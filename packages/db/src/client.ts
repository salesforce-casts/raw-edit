import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

let cached: { db: Database; sql: postgres.Sql } | null = null;

export interface DbOptions {
  connectionString?: string;
  /**
   * Serverless functions must not hold a pool per invocation. Neon's pooled endpoint
   * plus a max of 1 connection is the combination that behaves on Vercel.
   */
  max?: number;
  idleTimeoutSeconds?: number;
  prepare?: boolean;
}

export function createDb(options: DbOptions = {}): { db: Database; sql: postgres.Sql } {
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  const sql = postgres(connectionString, {
    max: options.max ?? 1,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 15,
    // Neon's pooled endpoint (pgbouncer in transaction mode) cannot use prepared
    // statements; the worker connects directly and can.
    prepare: options.prepare ?? false,
  });

  return { db: drizzle(sql, { schema }), sql };
}

/** Process-wide singleton. Safe on Vercel because `max` is 1. */
export function getDb(options: DbOptions = {}): Database {
  if (!cached) cached = createDb(options);
  return cached.db;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = null;
  }
}

export { schema };
