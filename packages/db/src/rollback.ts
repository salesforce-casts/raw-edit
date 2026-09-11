import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

async function rollback() {
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1 });
  const drizzleDir = join(here, "..", "drizzle");
  const target = process.argv[2] ?? "0002_script_pass.sql";
  const downFile = target.replace(/\.sql$/, ".down.sql");
  const downPath = join(drizzleDir, downFile);

  try {
    const applied = await sql<{ id: string }[]>`
      SELECT id FROM raw_edit_migrations WHERE id = ${target}
    `;
    if (applied.length === 0) {
      console.log(`nothing to roll back (${target} is not applied)`);
      return;
    }
    if (!existsSync(downPath)) {
      throw new Error(`missing down file ${downFile}`);
    }
    await sql.unsafe(readFileSync(downPath, "utf8"));
    await sql`DELETE FROM raw_edit_migrations WHERE id = ${target}`;
    console.log(`rolled back ${target}`);
  } finally {
    await sql.end();
  }
}

rollback().catch((error) => {
  console.error(error);
  process.exit(1);
});
