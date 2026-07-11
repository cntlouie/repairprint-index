import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { commitCandidateImport, prepareCandidateImport, queueCandidateImportReview } from "../src/db/imports";
import { loadImportPack } from "./load-import-pack";
import { seedDatabase } from "./seed-data";
import * as schema from "../src/db/schema";

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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_TEST_URL is required for the destructive fresh-database check.");
  }

  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  const database = drizzle(sql, { schema });

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
    if (tableCount !== 26) throw new Error(`Expected 26 public tables after migration, found ${tableCount}.`);

    const viewRows = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name LIKE 'published_%'
    `;
    if (viewRows[0]?.viewCount !== 4) throw new Error("Expected four published-only anonymous views.");

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

    const [staff] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000101', 'reviewer@example.invalid', 'reviewer', 'active', true)
      RETURNING id
    `;
    if (!staff) throw new Error("Staff profile fixture was not created.");

    const importFiles = loadImportPack("data/fixtures/phase0-demo");
    const dryRun = await prepareCandidateImport(database, importFiles);
    if (!dryRun.canCommit || dryRun.counts.insert !== 20) {
      throw new Error(`Expected the fictional Phase 0 dry run to accept 20 candidate rows: ${JSON.stringify(dryRun.errors)}`);
    }
    const firstImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture.",
      requestId: "req_import_gate_first",
    });
    const secondImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture rerun.",
      requestId: "req_import_gate_second",
    });
    if (firstImport.reused || !secondImport.reused || secondImport.runId !== firstImport.runId) {
      throw new Error("Repeated Phase 0 commit did not reuse the original import run.");
    }
    const [importCounts] = await sql<{ runs: number; rows: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs) AS runs,
        (SELECT count(*)::int FROM import_rows) AS rows
    `;
    if (importCounts?.runs !== 1 || importCounts.rows !== 20) {
      throw new Error(`Expected one import run and 20 candidate rows, found ${JSON.stringify(importCounts)}.`);
    }

    const ambiguousFiles = { ...importFiles };
    ambiguousFiles["product_identifiers.csv"] = ambiguousFiles["product_identifiers.csv"].replace(
      "DV-201-B,DV-201-B,DV201B",
      "DV201A,DV201A,DV201A",
    );
    const ambiguousDryRun = await prepareCandidateImport(database, ambiguousFiles);
    if (ambiguousDryRun.canCommit || !ambiguousDryRun.errors.some((entry) => entry.code === "MODEL_AMBIGUOUS")) {
      throw new Error("Ambiguous model collision did not block commit with MODEL_AMBIGUOUS.");
    }
    const queued = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture.",
      requestId: "req_import_collision_gate",
    });
    const queuedAgain = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture rerun.",
      requestId: "req_import_collision_gate_rerun",
    });
    if (queued.reused || !queuedAgain.reused || queuedAgain.runId !== queued.runId) {
      throw new Error("Repeated collision queue write did not reuse the original failed import run.");
    }
    const [collisionCounts] = await sql<{ failedRuns: number; collisions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs WHERE status = 'failed') AS "failedRuns",
        (SELECT count(*)::int FROM import_collisions WHERE status = 'open') AS collisions
    `;
    if (collisionCounts?.failedRuns !== 1 || collisionCounts.collisions < 1) {
      throw new Error(`Expected one failed run with an open collision, found ${JSON.stringify(collisionCounts)}.`);
    }

    const [audit] = await sql<{ id: string }[]>`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${staff.id}, 'fixture.review', 'fitment', '00000000-0000-4000-8000-000000000201',
        '{}'::jsonb, '{"status":"reviewed"}'::jsonb, 'Fresh database fixture.', 'req_database_gate')
      RETURNING id
    `;
    if (!audit) throw new Error("Audit fixture was not written.");

    let mutationRejected = false;
    try {
      await sql`DELETE FROM audit_log WHERE id = ${audit.id}`;
    } catch (error) {
      mutationRejected = error instanceof Error && error.message.includes("audit_log is append-only");
    }
    if (!mutationRejected) throw new Error("Audit rows must reject update/delete mutations.");

    const [anonymousPublished] = await sql<{ rowCount: number }[]>`
      SELECT count(*)::int AS "rowCount" FROM published_fitments
    `;
    if (anonymousPublished?.rowCount !== 0) {
      throw new Error("Anonymous published view exposed a fictional draft fitment.");
    }

    console.log("Database checks passed: migrations, seed, 20-row idempotent import, published views, staff constraints, and immutable audit are valid.");
  } finally {
    await sql.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
