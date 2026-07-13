import { createHash } from "node:crypto";

import postgres from "postgres";

const EXPECTED_EXTENSION_NAME = "pg_trgm";
const EXPECTED_EXTENSION_VERSION = "1.6";
const EXPECTED_ROUTINE_COUNT = 31;
const ANALYTICS_ROLES = [
  "repairprint_analytics_service",
  "repairprint_analytics_maintenance",
] as const;
const FRESH_ACL_GRANTEES = ["PUBLIC", "repairprint"] as const;
const STAGING_ACL_GRANTEES = [
  "PUBLIC",
  "anon",
  "authenticated",
  "postgres",
  "service_role",
  "supabase_admin",
] as const;

interface AclRow {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
  readonly signature: string;
}

interface CanonicalAclEntry {
  readonly grantor: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
}

interface CanonicalManifest {
  readonly extension: {
    readonly name: string;
    readonly version: string;
    readonly schema: string;
    readonly owner: string;
    readonly relocatable: boolean;
    readonly configuration: readonly string[];
    readonly conditions: readonly string[];
  };
  readonly routines: readonly CanonicalRoutine[];
}

interface CanonicalRoutine {
  readonly schema: string;
  readonly signature: string;
  readonly result: string;
  readonly owner: string;
  readonly language: string;
  readonly kind: string;
  readonly securityDefiner: boolean;
  readonly volatility: string;
  readonly parallel: string;
  readonly leakproof: boolean;
  readonly strict: boolean;
  readonly returnsSet: boolean;
  readonly configuration: readonly string[];
  readonly definitionSha256: string;
  readonly aclDefaulted: boolean;
  readonly acl: readonly CanonicalAclEntry[];
}

interface ExtensionRow {
  readonly conditions: string[] | null;
  readonly configuration: string[] | null;
  readonly name: string;
  readonly owner: string;
  readonly relocatable: boolean;
  readonly schema: string;
  readonly version: string;
}

interface LedgerRow {
  readonly createdAt: string;
  readonly hash: string;
}

interface RoutineRow {
  readonly aclDefaulted: boolean;
  readonly configuration: string[] | null;
  readonly definition: string;
  readonly kind: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly owner: string;
  readonly parallel: string;
  readonly result: string;
  readonly returnsSet: boolean;
  readonly schema: string;
  readonly securityDefiner: boolean;
  readonly signature: string;
  readonly strict: boolean;
  readonly volatility: string;
}

function requireCondition(condition: boolean, code: string, details?: unknown): void {
  if (condition) return;
  const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
  throw new Error(`${code}${suffix}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareAcl(left: CanonicalAclEntry, right: CanonicalAclEntry): number {
  const leftKey = JSON.stringify(left);
  const rightKey = JSON.stringify(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function compareRoutine(left: CanonicalRoutine, right: CanonicalRoutine): number {
  return left.signature < right.signature
    ? -1
    : left.signature > right.signature ? 1 : 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the pg_trgm staging preflight.");
  }

  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    connection: {
      application_name: "wp11-pg-trgm-readonly-preflight",
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
    await sql.unsafe("SET LOCAL search_path = pg_catalog");

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
      "PG_TRGM_PREFLIGHT_TRANSACTION_NOT_READ_ONLY",
      transaction,
    );

    const ledger = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;

    const extensions = await sql<ExtensionRow[]>`
      SELECT extension.extname AS name,
        extension.extversion AS version,
        namespace.nspname AS schema,
        owner_role.rolname AS owner,
        extension.extrelocatable AS relocatable,
        extension.extconfig::text[] AS configuration,
        extension.extcondition AS conditions
      FROM pg_extension AS extension
      INNER JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
      INNER JOIN pg_roles AS owner_role ON owner_role.oid = extension.extowner
      WHERE extension.extname = ${EXPECTED_EXTENSION_NAME}
    `;
    requireCondition(
      extensions.length === 1,
      "PG_TRGM_PREFLIGHT_EXTENSION_COUNT_INVALID",
      { actual: extensions.length },
    );
    const extension = extensions[0];
    if (!extension) {
      throw new Error("PG_TRGM_PREFLIGHT_EXTENSION_MISSING");
    }
    requireCondition(
      extension.name === EXPECTED_EXTENSION_NAME
        && extension.version === EXPECTED_EXTENSION_VERSION
        && extension.schema === "public"
        && extension.relocatable
        && (extension.configuration?.length ?? 0) === 0
        && (extension.conditions?.length ?? 0) === 0
        && !ANALYTICS_ROLES.includes(
          extension.owner as (typeof ANALYTICS_ROLES)[number],
        ),
      "PG_TRGM_PREFLIGHT_EXTENSION_STATE_INVALID",
      extension,
    );

    const routines = await sql<RoutineRow[]>`
      SELECT namespace.nspname AS schema,
        format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)) AS signature,
        pg_get_function_result(procedure.oid) AS result,
        owner_role.rolname AS owner,
        language.lanname AS language,
        CASE procedure.prokind
          WHEN 'f' THEN 'function'
          WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate'
          WHEN 'w' THEN 'window'
          ELSE procedure.prokind::text
        END AS kind,
        procedure.prosecdef AS "securityDefiner",
        CASE procedure.provolatile
          WHEN 'i' THEN 'immutable'
          WHEN 's' THEN 'stable'
          WHEN 'v' THEN 'volatile'
          ELSE procedure.provolatile::text
        END AS volatility,
        CASE procedure.proparallel
          WHEN 's' THEN 'safe'
          WHEN 'r' THEN 'restricted'
          WHEN 'u' THEN 'unsafe'
          ELSE procedure.proparallel::text
        END AS parallel,
        procedure.proleakproof AS leakproof,
        procedure.proisstrict AS strict,
        procedure.proretset AS "returnsSet",
        procedure.proconfig AS configuration,
        pg_get_functiondef(procedure.oid) AS definition,
        procedure.proacl IS NULL AS "aclDefaulted"
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      INNER JOIN pg_language AS language ON language.oid = procedure.prolang
      INNER JOIN pg_depend AS dependency
        ON dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = procedure.oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_extension'::regclass
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'e'
      INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE extension.extname = ${EXPECTED_EXTENSION_NAME}
      ORDER BY signature
    `;
    requireCondition(
      routines.length === EXPECTED_ROUTINE_COUNT,
      "PG_TRGM_PREFLIGHT_ROUTINE_COUNT_INVALID",
      { expected: EXPECTED_ROUTINE_COUNT, actual: routines.length },
    );

    const aclRows = await sql<AclRow[]>`
      SELECT format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)) AS signature,
        pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee
          WHEN 0 THEN 'PUBLIC'
          ELSE pg_get_userbyid(acl.grantee)
        END AS grantee,
        acl.privilege_type AS privilege,
        acl.is_grantable AS grantable
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_depend AS dependency
        ON dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = procedure.oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_extension'::regclass
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'e'
      INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
      CROSS JOIN LATERAL aclexplode(
        COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
      WHERE extension.extname = ${EXPECTED_EXTENSION_NAME}
      ORDER BY signature, grantee, grantor, privilege, grantable
    `;

    const explicitAnalyticsGrants = await sql<{
      readonly grantee: string;
      readonly signature: string;
    }[]>`
      SELECT role.rolname AS grantee,
        format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)) AS signature
      FROM pg_proc AS procedure
      INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_depend AS dependency
        ON dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = procedure.oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_extension'::regclass
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'e'
      INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
      INNER JOIN pg_roles AS role ON role.oid = acl.grantee
      WHERE extension.extname = ${EXPECTED_EXTENSION_NAME}
        AND role.rolname IN (
          'repairprint_analytics_service',
          'repairprint_analytics_maintenance'
        )
        AND acl.privilege_type = 'EXECUTE'
      ORDER BY signature, grantee
    `;
    requireCondition(
      explicitAnalyticsGrants.length === 0,
      "PG_TRGM_PREFLIGHT_DIRECT_ANALYTICS_GRANT",
      explicitAnalyticsGrants,
    );

    const aclBySignature = new Map<string, CanonicalAclEntry[]>();
    for (const row of aclRows) {
      const entries = aclBySignature.get(row.signature) ?? [];
      entries.push({
        grantor: row.grantor,
        grantee: row.grantee,
        privilege: row.privilege,
        grantable: row.grantable,
      });
      aclBySignature.set(row.signature, entries);
    }

    const canonicalRoutines = routines.map((routine): CanonicalRoutine => {
      const acl = [...(aclBySignature.get(routine.signature) ?? [])].sort(compareAcl);
      const expectedAclGrantees = extension.owner === "repairprint"
        ? FRESH_ACL_GRANTEES
        : extension.owner === "supabase_admin" ? STAGING_ACL_GRANTEES : [];
      requireCondition(
        routine.schema === "public"
          && routine.owner === extension.owner
          && !routine.securityDefiner
          && (routine.configuration?.length ?? 0) === 0
          && acl.length === expectedAclGrantees.length
          && acl.every((entry) => entry.grantor === extension.owner
            && entry.privilege === "EXECUTE"
            && !entry.grantable)
          && expectedAclGrantees.every((grantee) => (
            acl.filter((entry) => entry.grantee === grantee).length === 1
          )),
        "PG_TRGM_PREFLIGHT_ROUTINE_STATE_INVALID",
        {
          signature: routine.signature,
          extensionOwner: extension.owner,
          routineOwner: routine.owner,
          securityDefiner: routine.securityDefiner,
          configuration: routine.configuration ?? [],
          aclDefaulted: routine.aclDefaulted,
          acl,
        },
      );
      return {
        schema: routine.schema,
        signature: routine.signature,
        result: routine.result,
        owner: routine.owner,
        language: routine.language,
        kind: routine.kind,
        securityDefiner: routine.securityDefiner,
        volatility: routine.volatility,
        parallel: routine.parallel,
        leakproof: routine.leakproof,
        strict: routine.strict,
        returnsSet: routine.returnsSet,
        configuration: [...(routine.configuration ?? [])].sort(),
        definitionSha256: sha256(routine.definition),
        aclDefaulted: routine.aclDefaulted,
        acl,
      };
    }).sort(compareRoutine);

    const manifest: CanonicalManifest = {
      extension: {
        name: extension.name,
        version: extension.version,
        schema: extension.schema,
        owner: extension.owner,
        relocatable: extension.relocatable,
        configuration: [...(extension.configuration ?? [])].sort(),
        conditions: [...(extension.conditions ?? [])].sort(),
      },
      routines: canonicalRoutines,
    };
    const manifestJson = JSON.stringify(manifest);

    let writeProbeCode: string | undefined;
    await sql.unsafe("SAVEPOINT wp11_pg_trgm_read_only_probe");
    try {
      await sql.unsafe("UPDATE drizzle.__drizzle_migrations SET hash = hash WHERE false");
    } catch (error: unknown) {
      writeProbeCode = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      await sql.unsafe("ROLLBACK TO SAVEPOINT wp11_pg_trgm_read_only_probe");
    }
    requireCondition(
      writeProbeCode === "25006",
      "PG_TRGM_PREFLIGHT_READ_ONLY_WRITE_PROBE_INVALID",
      { code: writeProbeCode ?? "none" },
    );
    await sql.unsafe("RELEASE SAVEPOINT wp11_pg_trgm_read_only_probe");

    const ledgerAfterProbe = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    requireCondition(
      JSON.stringify(ledgerAfterProbe) === JSON.stringify(ledger),
      "PG_TRGM_PREFLIGHT_LEDGER_CHANGED",
    );

    evidence = {
      code: "WP11_PG_TRGM_STAGING_READ_ONLY_PREFLIGHT_VERIFIED",
      transaction: {
        startupDefaultReadOnly: transaction?.defaultTransactionReadOnly,
        explicitReadOnly: true,
        isolation: transaction?.isolation,
        writeProbeSqlstate: writeProbeCode,
        ledgerSnapshotStable: true,
        end: "ROLLBACK",
      },
      fingerprint: sha256(manifestJson),
      routineCount: canonicalRoutines.length,
      manifest,
    };
  } finally {
    if (transactionOpen) await sql.unsafe("ROLLBACK");
    await sql.end();
  }

  console.log(JSON.stringify(evidence));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("PG_TRGM_PREFLIGHT_")) {
    console.error(message);
  } else if (typeof error === "object" && error !== null && "code" in error) {
    console.error(`PG_TRGM_PREFLIGHT_DATABASE_ERROR: ${String(error.code)}`);
  } else {
    console.error("PG_TRGM_PREFLIGHT_FAILED");
  }
  process.exitCode = 1;
});
