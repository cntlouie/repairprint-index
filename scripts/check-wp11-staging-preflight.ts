import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

interface DrizzleJournal {
  readonly entries: readonly JournalEntry[];
}

interface ExpectedMigration {
  readonly createdAt: string;
  readonly hash: string;
  readonly tag: string;
}

interface LedgerRow {
  readonly createdAt: string;
  readonly hash: string;
}

interface SourceFunctionRow {
  readonly anonExecute: boolean;
  readonly authenticatedExecute: boolean;
  readonly definition: string | null;
  readonly exists: boolean;
  readonly owner: string | null;
  readonly ownerBoundServiceGrant: boolean;
  readonly publicExecute: boolean;
  readonly searchPath: string[] | null;
  readonly securityDefiner: boolean;
  readonly serviceGrantCount: number;
  readonly serviceGrantableCount: number;
  readonly serviceExecute: boolean;
  readonly signature: string;
}

interface MembershipRow {
  readonly adminOption: boolean;
  readonly grantedRole: string;
  readonly grantorRole: string | null;
  readonly inheritOption: boolean;
  readonly memberRole: string;
  readonly setOption: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const sourceFunctionSignatures = [
  "public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)",
  "public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)",
  "public.claim_source_link_check_jobs(text,integer,integer)",
  "public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)",
] as const;

function readExpectedMigrations(): {
  readonly applied: readonly ExpectedMigration[];
  readonly wp11: ExpectedMigration;
} {
  const migrationsDirectory = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  ) as DrizzleJournal;
  const migrations = journal.entries.map((entry) => {
    const migration = readFileSync(
      path.join(migrationsDirectory, `${entry.tag}.sql`),
      "utf8",
    );
    return Object.freeze({
      tag: entry.tag,
      hash: createHash("sha256").update(migration).digest("hex"),
      createdAt: String(entry.when),
    });
  });
  const applied = migrations.filter(({ tag }) => /^00(?:0\d|1[01])_/u.test(tag));
  const wp11 = migrations.find(({ tag }) => tag.startsWith("0012_"));
  if (applied.length !== 12 || !wp11) {
    throw new Error("STAGING_PREFLIGHT_LOCAL_MIGRATION_SET_INVALID");
  }
  return { applied, wp11 };
}

function requireCondition(condition: boolean, code: string, details?: unknown): void {
  if (condition) return;
  const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
  throw new Error(`${code}${suffix}`);
}

function assessSourceMemberships(memberships: readonly MembershipRow[]): boolean {
  if (memberships.length === 0) return true;
  if (memberships.length !== 2) return false;
  const expected = new Set([
    "repairprint_source_service",
    "repairprint_source_maintenance",
  ]);
  return memberships.every((membership) => {
    if (!expected.delete(membership.grantedRole)) return false;
    return membership.memberRole === "postgres"
      && membership.grantorRole === "supabase_admin"
      && membership.adminOption
      && !membership.inheritOption
      && !membership.setOption;
  }) && expected.size === 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the staging preflight.");

  const expected = readExpectedMigrations();
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    connection: {
      application_name: "wp11-staging-readonly-preflight",
      default_transaction_read_only: true,
      statement_timeout: 60_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });
  let transactionOpen = false;
  let evidence: Record<string, unknown> | undefined;

  try {
    await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;

    const [transaction] = await sql<{
      defaultTransactionReadOnly: boolean;
      isolation: string;
      transactionReadOnly: boolean;
    }[]>`
      SELECT current_setting('default_transaction_read_only')::boolean
          AS "defaultTransactionReadOnly",
        current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only')::boolean AS "transactionReadOnly"
    `;
    requireCondition(
      transaction?.transactionReadOnly === true
        && transaction.isolation === "repeatable read",
      "STAGING_PREFLIGHT_TRANSACTION_NOT_READ_ONLY",
      transaction,
    );

    const ledger = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    requireCondition(
      ledger.length === expected.applied.length,
      "STAGING_PREFLIGHT_LEDGER_COUNT_INVALID",
      { expected: expected.applied.length, actual: ledger.length },
    );
    for (const [index, migration] of expected.applied.entries()) {
      const row = ledger[index];
      requireCondition(
        row?.hash === migration.hash && row.createdAt === migration.createdAt,
        "STAGING_PREFLIGHT_LEDGER_ENTRY_INVALID",
        { tag: migration.tag, position: index },
      );
    }
    requireCondition(
      !ledger.some(({ hash, createdAt }) => hash === expected.wp11.hash
        || createdAt === expected.wp11.createdAt),
      "STAGING_PREFLIGHT_0012_LEDGERED",
    );

    const analyticsRoleRows = await sql<{ identity: string; kind: string }[]>`
      SELECT 'role'::text AS kind, rolname AS identity
      FROM pg_roles
      WHERE rolname ~ '^repairprint_analytics_'
      ORDER BY rolname
    `;
    requireCondition(
      analyticsRoleRows.length === 0,
      "STAGING_PREFLIGHT_ANALYTICS_ROLE_RESIDUE",
      analyticsRoleRows,
    );

    const analyticsObjects = await sql<{ identity: string; kind: string }[]>`
      SELECT 'relation'::text AS kind,
        format('%I.%I', namespace.nspname, relation.relname) AS identity
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname ~ '^private_analytics_'
      UNION ALL
      SELECT 'function'::text AS kind,
        format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)) AS identity
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname ~ '^record_private_analytics_'
      UNION ALL
      SELECT 'constraint'::text AS kind, constraint_name.conname AS identity
      FROM pg_constraint AS constraint_name
      WHERE constraint_name.conname LIKE 'private_analytics%'
      ORDER BY kind, identity
    `;
    requireCondition(
      analyticsObjects.length === 0,
      "STAGING_PREFLIGHT_ANALYTICS_OBJECT_RESIDUE",
      analyticsObjects,
    );

    const analyticsMemberships = await sql<MembershipRow[]>`
      SELECT granted_role.rolname AS "grantedRole",
        member_role.rolname AS "memberRole",
        grantor_role.rolname AS "grantorRole",
        membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption",
        membership.set_option AS "setOption"
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname ~ '^repairprint_analytics_'
         OR member_role.rolname ~ '^repairprint_analytics_'
         OR grantor_role.rolname ~ '^repairprint_analytics_'
      ORDER BY granted_role.rolname, member_role.rolname
    `;
    requireCondition(
      analyticsMemberships.length === 0,
      "STAGING_PREFLIGHT_ANALYTICS_MEMBERSHIP_RESIDUE",
      analyticsMemberships,
    );

    const [analyticsAcl] = await sql<{ count: number }[]>`
      WITH analytics_role AS (
        SELECT oid FROM pg_roles WHERE rolname ~ '^repairprint_analytics_'
      ), acl AS (
        SELECT exploded.grantee, exploded.grantor
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS exploded
        UNION ALL
        SELECT exploded.grantee, exploded.grantor
        FROM pg_class AS relation
        CROSS JOIN LATERAL aclexplode(relation.relacl) AS exploded
        UNION ALL
        SELECT exploded.grantee, exploded.grantor
        FROM pg_proc AS procedure
        CROSS JOIN LATERAL aclexplode(procedure.proacl) AS exploded
        UNION ALL
        SELECT exploded.grantee, exploded.grantor
        FROM pg_default_acl AS default_acl
        CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS exploded
      )
      SELECT count(*)::int AS count
      FROM acl
      WHERE grantee IN (SELECT oid FROM analytics_role)
         OR grantor IN (SELECT oid FROM analytics_role)
    `;
    requireCondition(
      analyticsAcl?.count === 0,
      "STAGING_PREFLIGHT_ANALYTICS_ACL_RESIDUE",
      analyticsAcl,
    );

    const sourceFunctions = await sql<SourceFunctionRow[]>`
      WITH expected(signature) AS (
        SELECT unnest(${sourceFunctionSignatures as unknown as string[]}::text[])
      ), resolved AS (
        SELECT signature, to_regprocedure(signature) AS oid FROM expected
      )
      SELECT resolved.signature,
        procedure.oid IS NOT NULL AS exists,
        pg_get_functiondef(procedure.oid) AS definition,
        owner_role.rolname AS owner,
        COALESCE(procedure.prosecdef, false) AS "securityDefiner",
        procedure.proconfig AS "searchPath",
        CASE WHEN procedure.oid IS NULL THEN false ELSE
          has_function_privilege('repairprint_source_service', procedure.oid, 'EXECUTE')
        END AS "serviceExecute",
        CASE WHEN procedure.oid IS NULL THEN false ELSE EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(
            procedure.proacl,
            acldefault('f', procedure.proowner)
          )) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) END AS "publicExecute",
        CASE WHEN procedure.oid IS NULL
          OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
          THEN false ELSE has_function_privilege('anon', procedure.oid, 'EXECUTE')
        END AS "anonExecute",
        CASE WHEN procedure.oid IS NULL
          OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
          THEN false ELSE has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        END AS "authenticatedExecute",
        CASE WHEN procedure.oid IS NULL THEN false ELSE EXISTS (
          SELECT 1
          FROM aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (
              SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service'
            )
            AND acl.grantor = (
              SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_maintenance'
            )
            AND acl.privilege_type = 'EXECUTE'
        ) END AS "ownerBoundServiceGrant",
        CASE WHEN procedure.oid IS NULL THEN 0 ELSE (
          SELECT count(*)::int
          FROM aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (
              SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service'
            )
            AND acl.privilege_type = 'EXECUTE'
        ) END AS "serviceGrantCount",
        CASE WHEN procedure.oid IS NULL THEN 0 ELSE (
          SELECT count(*)::int
          FROM aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (
              SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service'
            )
            AND acl.privilege_type = 'EXECUTE'
            AND acl.is_grantable
        ) END AS "serviceGrantableCount"
      FROM resolved
      LEFT JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
      LEFT JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      ORDER BY resolved.signature
    `;
    const sourceFunctionEvidence = sourceFunctions.map((fn) => ({
      signature: fn.signature,
      definitionSha256: fn.definition ? sha256(fn.definition) : null,
      owner: fn.owner,
      securityDefiner: fn.securityDefiner,
      searchPath: fn.searchPath,
      serviceExecute: fn.serviceExecute,
      serviceGrantCount: fn.serviceGrantCount,
      serviceGrantableCount: fn.serviceGrantableCount,
      ownerBoundServiceGrant: fn.ownerBoundServiceGrant,
      publicExecute: fn.publicExecute,
      anonExecute: fn.anonExecute,
      authenticatedExecute: fn.authenticatedExecute,
    }));
    requireCondition(
      sourceFunctions.length === sourceFunctionSignatures.length
        && sourceFunctions.every((fn) => fn.exists
          && fn.definition !== null
          && fn.owner === "repairprint_source_maintenance"
          && fn.securityDefiner
          && fn.searchPath?.length === 1
          && fn.searchPath[0] === "search_path=pg_catalog"
          && fn.serviceExecute
          && !fn.publicExecute
          && !fn.anonExecute
          && !fn.authenticatedExecute
          && fn.serviceGrantCount === 1
          && fn.serviceGrantableCount === 0
          && fn.ownerBoundServiceGrant),
      "STAGING_PREFLIGHT_WP10_FUNCTION_BOUNDARY_INVALID",
      sourceFunctionEvidence,
    );

    const [extraSourceExecute] = await sql<{ count: number }[]>`
      WITH expected(oid) AS (
        SELECT to_regprocedure(signature)::oid
        FROM unnest(${sourceFunctionSignatures as unknown as string[]}::text[]) AS signature
      )
      SELECT count(*)::int AS count
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      WHERE namespace.nspname = 'public'
        AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service')
        AND acl.privilege_type = 'EXECUTE'
        AND procedure.oid NOT IN (SELECT oid FROM expected)
    `;
    requireCondition(
      extraSourceExecute?.count === 0,
      "STAGING_PREFLIGHT_WP10_EXTRA_FUNCTION_GRANT",
      extraSourceExecute,
    );

    const [unexpectedSourceOverloads] = await sql<{ count: number }[]>`
      WITH expected(oid) AS (
        SELECT to_regprocedure(signature)::oid
        FROM unnest(${sourceFunctionSignatures as unknown as string[]}::text[]) AS signature
      )
      SELECT count(*)::int AS count
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'upsert_private_source_candidate',
          'transition_source_candidate_version',
          'claim_source_link_check_jobs',
          'complete_source_link_check'
        )
        AND procedure.oid NOT IN (SELECT oid FROM expected)
    `;
    requireCondition(
      unexpectedSourceOverloads?.count === 0,
      "STAGING_PREFLIGHT_WP10_UNEXPECTED_OVERLOAD",
      unexpectedSourceOverloads,
    );

    const sourceMemberships = await sql<MembershipRow[]>`
      SELECT granted_role.rolname AS "grantedRole",
        member_role.rolname AS "memberRole",
        grantor_role.rolname AS "grantorRole",
        membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption",
        membership.set_option AS "setOption"
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
         OR member_role.rolname IN ('repairprint_source_service', 'repairprint_source_maintenance')
      ORDER BY granted_role.rolname, member_role.rolname
    `;
    requireCondition(
      assessSourceMemberships(sourceMemberships),
      "STAGING_PREFLIGHT_WP10_MEMBERSHIP_INVALID",
      sourceMemberships,
    );

    let writeProbeCode: string | undefined;
    await sql.unsafe("SAVEPOINT wp11_read_only_probe");
    try {
      await sql.unsafe("UPDATE drizzle.__drizzle_migrations SET hash = hash WHERE false");
    } catch (error: unknown) {
      writeProbeCode = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      await sql.unsafe("ROLLBACK TO SAVEPOINT wp11_read_only_probe");
    }
    requireCondition(
      writeProbeCode === "25006",
      "STAGING_PREFLIGHT_READ_ONLY_WRITE_PROBE_INVALID",
      { code: writeProbeCode ?? "none" },
    );
    await sql.unsafe("RELEASE SAVEPOINT wp11_read_only_probe");

    const ledgerAfterProbe = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    requireCondition(
      JSON.stringify(ledgerAfterProbe) === JSON.stringify(ledger),
      "STAGING_PREFLIGHT_LEDGER_CHANGED_DURING_PROBE",
    );

    evidence = {
      code: "WP11_STAGING_READ_ONLY_PREFLIGHT_VERIFIED",
      transaction: {
        startupDefaultReadOnly: transaction?.defaultTransactionReadOnly,
        explicitReadOnly: true,
        isolation: transaction?.isolation,
        writeProbeSqlstate: writeProbeCode,
        ledgerSnapshotStable: true,
        end: "ROLLBACK",
      },
      ledger: expected.applied.map(({ tag, hash }) => ({ tag, hash })),
      migration0012Ledgered: false,
      analytics: {
        roles: analyticsRoleRows,
        objects: analyticsObjects,
        memberships: analyticsMemberships,
        aclEntries: analyticsAcl?.count ?? -1,
      },
      wp10: {
        functions: sourceFunctionEvidence,
        extraServiceFunctionGrants: extraSourceExecute?.count ?? -1,
        unexpectedOverloads: unexpectedSourceOverloads?.count ?? -1,
        memberships: sourceMemberships,
      },
    };
  } finally {
    if (transactionOpen) await sql.unsafe("ROLLBACK");
    await sql.end();
  }

  console.log(JSON.stringify(evidence));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("STAGING_PREFLIGHT_")) {
    console.error(message);
  } else if (typeof error === "object" && error !== null && "code" in error) {
    console.error(`STAGING_PREFLIGHT_DATABASE_ERROR: ${String(error.code)}`);
  } else {
    console.error("STAGING_PREFLIGHT_FAILED");
  }
  process.exitCode = 1;
});
