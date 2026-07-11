import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { seedDatabase } from "./seed-data";
import * as schema from "../src/db/schema";

const databaseUrl = process.env.DATABASE_TEST_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_TEST_URL is required for the destructive fresh-database check.");
}

assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");

const sql = postgres(databaseUrl, { prepare: false, max: 1 });
const database = drizzle(sql, { schema });

const seededTables = [
  "brands",
  "categories",
  "components",
  "creators",
  "design_revisions",
  "designs",
  "fitment_evidence",
  "fitments",
  "product_components",
  "product_identifiers",
  "product_models",
  "safety_reviews",
  "sources",
] as const;

try {
  await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
  await sql.unsafe('CREATE SCHEMA "public"');
  await migrate(database, { migrationsFolder: "drizzle" });
  await migrate(database, { migrationsFolder: "drizzle" });

  const tableRows = await sql<{ tableCount: number }[]>`
    SELECT count(*)::int AS "tableCount"
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  const tableCount = tableRows[0]?.tableCount;
  if (tableCount !== 22) throw new Error(`Expected 22 public tables after migration, found ${tableCount}.`);

  const extensionRows = await sql<{ extensionCount: number }[]>`
    SELECT count(*)::int AS "extensionCount" FROM pg_extension WHERE extname = 'pg_trgm'
  `;
  const extensionCount = extensionRows[0]?.extensionCount;
  if (extensionCount !== 1) throw new Error("pg_trgm extension was not installed by the migration.");

  await seedDatabase(database);
  await seedDatabase(database);

  for (const table of seededTables) {
    const rowCountRows = await sql.unsafe<{ rowCount: number }[]>(
      `SELECT count(*)::int AS "rowCount" FROM "${table}"`,
    );
    const rowCount = rowCountRows[0]?.rowCount;
    if (rowCount !== 1) throw new Error(`Expected one idempotent seed row in ${table}, found ${rowCount}.`);
  }

  const publishedRows = await sql<{ publishedCount: number }[]>`
    SELECT count(*)::int AS "publishedCount" FROM fitments WHERE publication_status = 'published'
  `;
  const publishedCount = publishedRows[0]?.publishedCount;
  if (publishedCount !== 0) throw new Error("The fictional seed must not publish a fitment.");

  console.log("Database checks passed: zero-state migration, migration replay, pg_trgm, and double seed are valid.");
} finally {
  await sql.end();
}
