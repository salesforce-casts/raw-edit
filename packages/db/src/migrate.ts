import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1 });
  const drizzleDir = join(here, "..", "drizzle");
  const files = readdirSync(drizzleDir)
    .filter((file) => file.endsWith(".sql"))
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
    await sql.unsafe(contents);
    await sql`INSERT INTO raw_edit_migrations (id) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
  await sql.end();
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
