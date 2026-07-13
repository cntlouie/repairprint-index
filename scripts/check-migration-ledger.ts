import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import postgres from "postgres";

import {
  assessMigrationLedger,
  type ExpectedMigrationLedgerEntry,
} from "../src/domain/migration-ledger";

interface DrizzleJournal {
  readonly entries: readonly {
    readonly tag: string;
    readonly when: number;
  }[];
}

function readExpectedMigrations(): readonly ExpectedMigrationLedgerEntry[] {
  const migrationsDirectory = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  ) as DrizzleJournal;

  return journal.entries.map((entry) => {
    const sql = readFileSync(path.join(migrationsDirectory, `${entry.tag}.sql`), "utf8");
    return {
      tag: entry.tag,
      hash: createHash("sha256").update(sql).digest("hex"),
      createdAt: String(entry.when),
    };
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the migration ledger check.");

  const expected = readExpectedMigrations();
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    const recorded = await sql<{ hash: string; createdAt: string }[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    const assessment = assessMigrationLedger(expected, recorded);
    if (!assessment.valid) {
      throw new Error(`Migration ledger verification failed: ${assessment.violations.join(" ")}`);
    }

    console.log(
      JSON.stringify({
        code: "MIGRATION_LEDGER_VERIFIED",
        migrations: expected.map(({ tag, hash }) => ({ tag, hash })),
      }),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration ledger verification failed.");
  process.exitCode = 1;
});
