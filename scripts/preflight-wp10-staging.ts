import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

interface DrizzleJournal {
  readonly entries: readonly { readonly tag: string; readonly when: number }[];
}

const wp10Relations = [
  "source_adapter_runs",
  "source_candidate_acquisitions",
  "source_candidate_versions",
  "source_candidates",
  "source_link_check_jobs",
  "source_policy_reviews",
] as const;

const wp10Functions = [
  "claim_source_link_check_jobs",
  "complete_source_link_check",
  "enqueue_source_link_check",
  "record_source_policy_review",
  "refresh_source_public_search",
  "reject_source_evidence_mutation",
  "transition_source_candidate_version",
  "upsert_private_source_candidate",
] as const;

const wp10Types = [
  "source_adapter_run_status",
  "source_candidate_origin",
  "source_ingestion_stage",
  "source_link_job_status",
] as const;

function expectedMigrations() {
  const directory = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(path.join(directory, "meta", "_journal.json"), "utf8")) as DrizzleJournal;
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    createdAt: String(entry.when),
    hash: createHash("sha256").update(readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8")).digest("hex"),
  }));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the WP-10 staging preflight.");
  const expected = expectedMigrations();
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    const report = await sql.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION READ ONLY");
      const [readOnly] = await transaction<{ readOnly: string }[]>`
        SELECT current_setting('transaction_read_only') AS "readOnly"
      `;
      const ledgerExists = await transaction<{ exists: boolean }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
      `;
      const recorded = ledgerExists[0]?.exists
        ? await transaction<{ createdAt: string; hash: string }[]>`
            SELECT created_at::text AS "createdAt", hash
            FROM drizzle.__drizzle_migrations
            ORDER BY created_at, id
          `
        : [];
      const ledger = recorded.map((entry, index) => ({
        position: index,
        inferredTag: expected[index]?.tag ?? null,
        createdAt: entry.createdAt,
        hash: entry.hash,
        matchesLocal: expected[index]?.createdAt === entry.createdAt && expected[index]?.hash === entry.hash,
      }));

      const roles = await transaction<{
        bypassRls: boolean;
        canLogin: boolean;
        createDb: boolean;
        createRole: boolean;
        inherit: boolean;
        replication: boolean;
        role: string;
        superuser: boolean;
      }[]>`
        SELECT rolname AS role, rolcanlogin AS "canLogin", rolsuper AS superuser,
          rolcreatedb AS "createDb", rolcreaterole AS "createRole", rolinherit AS inherit,
          rolreplication AS replication, rolbypassrls AS "bypassRls"
        FROM pg_roles
        WHERE rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
        ORDER BY rolname
      `;
      const memberships = await transaction<{
        adminOption: boolean;
        grantedRole: string;
        grantorRole: string | null;
        inheritOption: boolean;
        memberRole: string;
        setOption: boolean;
      }[]>`
        SELECT granted_role.rolname AS "grantedRole", member_role.rolname AS "memberRole",
          grantor_role.rolname AS "grantorRole", membership.admin_option AS "adminOption",
          membership.inherit_option AS "inheritOption", membership.set_option AS "setOption"
        FROM pg_auth_members AS membership
        INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
        LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
        WHERE granted_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
           OR member_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
        ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
      `;
      const relations = await transaction<{ name: string; kind: string }[]>`
        SELECT class.relname AS name, class.relkind::text AS kind
        FROM pg_class AS class
        INNER JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public' AND class.relname = ANY(${wp10Relations as unknown as string[]})
        ORDER BY class.relname
      `;
      const functions = await transaction<{ name: string; identityArguments: string }[]>`
        SELECT procedure.proname AS name,
          pg_get_function_identity_arguments(procedure.oid) AS "identityArguments"
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname = ANY(${wp10Functions as unknown as string[]})
        ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)
      `;
      const types = await transaction<{ name: string }[]>`
        SELECT type.typname AS name
        FROM pg_type AS type
        INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
        WHERE namespace.nspname = 'public' AND type.typname = ANY(${wp10Types as unknown as string[]})
        ORDER BY type.typname
      `;
      const addedColumns = await transaction<{ table: string; column: string }[]>`
        SELECT table_name AS table, column_name AS column
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'source_link_checks' AND column_name IN ('job_id', 'redirect_hops', 'retry_after_at', 'checked_by', 'content_checksum'))
            OR (table_name = 'source_platform_policies' AND column_name = 'terms_checksum'))
        ORDER BY table_name, ordinal_position
      `;

      const migrationState = Object.fromEntries(["0009_source_adapters_link_health", "0010_wp10_corrective_boundaries"].map((tag) => {
        const local = expected.find((entry) => entry.tag === tag);
        const ledgered = Boolean(local && recorded.some((entry) => entry.createdAt === local.createdAt && entry.hash === local.hash));
        return [tag, { ledgered, localHash: local?.hash ?? null }];
      }));

      return {
        code: "WP10_STAGING_READ_ONLY_PREFLIGHT",
        transactionReadOnly: readOnly?.readOnly === "on",
        ledger,
        migrationState,
        roles,
        memberships,
        persistedObjects: { relations, functions, types, addedColumns },
      };
    });

    console.log(JSON.stringify(report));
    if (!report.transactionReadOnly) throw new Error("WP-10 staging preflight was not read-only.");
    if (report.migrationState["0010_wp10_corrective_boundaries"]?.ledgered) {
      throw new Error("WP10_MIGRATION_0010_ALREADY_LEDGERED");
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WP-10 staging preflight failed.");
  process.exitCode = 1;
});
