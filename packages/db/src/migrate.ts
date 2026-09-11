import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

const enumValueStatement =
  /^\s*ALTER\s+TYPE\s+[\w".]+\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'(?:''|[^'])*'\s*;\s*$/gim;

async function applyMigration(sql: ReturnType<typeof postgres>, contents: string) {
  // PostgreSQL requires a newly-added enum value to be committed before any
  // later statement can use it. Execute leading enum additions separately so
  // a multi-statement migration is not treated as one implicit transaction.
  const enumAdditions = contents.match(enumValueStatement) ?? [];
  for (const statement of enumAdditions) {
    await sql.unsafe(statement);
  }

  const remainder = contents.replace(enumValueStatement, "").trim();
  if (remainder) await sql.unsafe(remainder);
}

async function migrate() {
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1 });
  const drizzleDir = join(here, "..", "drizzle");
  const files = readdirSync(drizzleDir)
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
    .sort();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS raw_edit_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const file of files) {
    const applied = await sql<{ id: string }[]>`
      SELECT id FROM raw_edit_migrations WHERE id = ${file}
    `;
    if (applied.length > 0) continue;
    const contents = readFileSync(join(drizzleDir, file), "utf8");
    await applyMigration(sql, contents);
    await sql`INSERT INTO raw_edit_migrations (id) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
  await sql.end();
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
