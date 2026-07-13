import { createHash } from "node:crypto";

import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";

const EXPECTED_MAIN_COMMIT = "8723114e467e27c515b854b8cf9bb2a6c7be768e";
const EXPECTED_MAIN_TREE = "9f98665d76cae8b235d40f31f955d6985f7c297e";

const sourceFunctions = [
  {
    name: "upsert_private_source_candidate",
    signature: "public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)",
    publicHash: "028b0dcd590a17876067d450b8810369867f620192446d83668d41dd2d7d088c",
    pgCatalogHash: "443d256e25525017669cbe6c6e03b7a992550b11b08b6018d551d332053386eb",
    inputTypes: [
      "pg_catalog.text", "pg_catalog.text", "public.source_candidate_origin",
      "pg_catalog.text", "pg_catalog.jsonb", "pg_catalog.text", "pg_catalog.uuid",
      "pg_catalog.timestamptz", "pg_catalog.uuid", "pg_catalog.text", "pg_catalog.text",
      "pg_catalog.text", "pg_catalog.text",
    ],
  },
  {
    name: "transition_source_candidate_version",
    signature: "public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)",
    publicHash: "d72ac45447578b826832039309e4a44bc4a16fd112e3080e37b3e0be802c22eb",
    pgCatalogHash: "c2eefd59d21719d118bad17e7e0c7babd4152d24e7cfab1c6f409fbed8ee48a7",
    inputTypes: [
      "pg_catalog.uuid", "public.source_ingestion_stage", "public.source_ingestion_stage",
      "pg_catalog.uuid", "pg_catalog.text", "pg_catalog.text",
    ],
  },
  {
    name: "claim_source_link_check_jobs",
    signature: "public.claim_source_link_check_jobs(text,integer,integer)",
    publicHash: "db0f2f3ea10e878802cfa1653a7df79e3668bcbecec9f09ebc0abc39d0647f5b",
    pgCatalogHash: "db0f2f3ea10e878802cfa1653a7df79e3668bcbecec9f09ebc0abc39d0647f5b",
    inputTypes: ["pg_catalog.text", "pg_catalog.int4", "pg_catalog.int4"],
  },
  {
    name: "complete_source_link_check",
    signature: "public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)",
    publicHash: "ec59f97ec0779229f0512033c421ad2224b187be1967f1aa44ea2e4e08915fb9",
    pgCatalogHash: "ec59f97ec0779229f0512033c421ad2224b187be1967f1aa44ea2e4e08915fb9",
    inputTypes: [
      "pg_catalog.uuid", "pg_catalog.uuid", "pg_catalog.uuid", "pg_catalog.int4",
      "pg_catalog.text", "pg_catalog.text", "pg_catalog.int4", "pg_catalog.text",
      "pg_catalog.int4", "pg_catalog.timestamptz", "pg_catalog.text", "pg_catalog.text",
    ],
  },
] as const;

interface FunctionHashRow {
  readonly definitionSha256: string;
  readonly name: string;
}

interface CanonicalFunctionRow {
  readonly aclDefaulted: boolean;
  readonly allArguments: readonly Readonly<{
    mode: string;
    name: string | null;
    type: string;
  }>[];
  readonly argumentDefaults: number;
  readonly configuration: readonly string[];
  readonly configurationDefaulted: boolean;
  readonly inputTypes: readonly string[];
  readonly kind: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly name: string;
  readonly owner: string;
  readonly parallel: string;
  readonly prosrcSha256: string;
  readonly returnType: string;
  readonly returnsSet: boolean;
  readonly schema: string;
  readonly securityDefiner: boolean;
  readonly storedAcl: readonly Readonly<{
    grantable: boolean;
    grantee: string;
    grantor: string;
    privilege: string;
  }>[];
  readonly strict: boolean;
  readonly volatility: string;
}

interface ConnectionStateRow {
  readonly currentRole: string;
  readonly defaultReadOnly: boolean;
  readonly searchPath: string;
  readonly sessionRole: string;
}

function requireCondition(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedCanonical(rows: readonly CanonicalFunctionRow[]): readonly CanonicalFunctionRow[] {
  return [...rows].sort((left, right) => {
    const leftIdentity = `${left.schema}.${left.name}(${left.inputTypes.join(",")})`;
    const rightIdentity = `${right.schema}.${right.name}(${right.inputTypes.join(",")})`;
    return leftIdentity.localeCompare(rightIdentity);
  });
}

function hashMap(rows: readonly FunctionHashRow[]): Readonly<Record<string, string>> {
  return Object.fromEntries(rows.map((row) => [row.name, row.definitionSha256]));
}

function requireExpectedHashes(
  rows: readonly FunctionHashRow[],
  field: "publicHash" | "pgCatalogHash",
  code: string,
): void {
  requireCondition(rows.length === sourceFunctions.length, code);
  const actual = hashMap(rows);
  requireCondition(
    sourceFunctions.every((routine) => actual[routine.name] === routine[field]),
    code,
  );
}

async function readFunctionDefinitionHashes(
  sql: ReturnType<typeof postgres>,
): Promise<readonly FunctionHashRow[]> {
  const signatures = sourceFunctions.map((routine) => routine.signature);
  return sql<FunctionHashRow[]>`
    WITH expected(signature) AS (
      SELECT pg_catalog.unnest(${signatures}::text[])
    )
    SELECT procedure.proname AS name,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(pg_catalog.pg_get_functiondef(procedure.oid), 'UTF8')
        ),
        'hex'
      ) AS "definitionSha256"
    FROM expected
    INNER JOIN pg_catalog.pg_proc AS procedure
      ON procedure.oid = pg_catalog.to_regprocedure(expected.signature)
    ORDER BY procedure.proname
  `;
}

async function readCanonicalFunctionState(
  sql: ReturnType<typeof postgres>,
): Promise<readonly CanonicalFunctionRow[]> {
  const names = sourceFunctions.map((routine) => routine.name);
  const rows = await sql<CanonicalFunctionRow[]>`
    WITH type_identity AS (
      SELECT type_name.oid,
        CASE
          WHEN type_name.typcategory = 'A' AND type_name.typelem <> 0 THEN
            pg_catalog.format('%I.%I[]', element_namespace.nspname, element_type.typname)
          ELSE pg_catalog.format('%I.%I', type_namespace.nspname, type_name.typname)
        END AS identity
      FROM pg_catalog.pg_type AS type_name
      INNER JOIN pg_catalog.pg_namespace AS type_namespace
        ON type_namespace.oid = type_name.typnamespace
      LEFT JOIN pg_catalog.pg_type AS element_type
        ON element_type.oid = type_name.typelem
      LEFT JOIN pg_catalog.pg_namespace AS element_namespace
        ON element_namespace.oid = element_type.typnamespace
    )
    SELECT namespace.nspname AS schema,
      procedure.proname AS name,
      procedure.prokind::text AS kind,
      owner.rolname AS owner,
      language.lanname AS language,
      procedure.prosecdef AS "securityDefiner",
      procedure.proconfig IS NULL AS "configurationDefaulted",
      COALESCE((
        SELECT pg_catalog.jsonb_agg(setting ORDER BY setting)
        FROM pg_catalog.unnest(procedure.proconfig) AS setting
      ), '[]'::jsonb) AS configuration,
      procedure.provolatile::text AS volatility,
      procedure.proparallel::text AS parallel,
      procedure.proisstrict AS strict,
      procedure.proleakproof AS leakproof,
      procedure.proretset AS "returnsSet",
      procedure.pronargdefaults AS "argumentDefaults",
      pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')),
        'hex'
      ) AS "prosrcSha256",
      procedure.proacl IS NULL AS "aclDefaulted",
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantor', grantor.rolname,
            'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
            'privilege', acl.privilege_type,
            'grantable', acl.is_grantable
          )
          ORDER BY grantor.rolname,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
            acl.privilege_type,
            acl.is_grantable
        )
        FROM pg_catalog.aclexplode(procedure.proacl) AS acl
        INNER JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
        LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
      ), '[]'::jsonb) AS "storedAcl",
      COALESCE((
        SELECT pg_catalog.jsonb_agg(argument_type.identity ORDER BY argument.ordinal)
        FROM pg_catalog.unnest(procedure.proargtypes::oid[])
          WITH ORDINALITY AS argument(type_oid, ordinal)
        INNER JOIN type_identity AS argument_type ON argument_type.oid = argument.type_oid
      ), '[]'::jsonb) AS "inputTypes",
      return_type.identity AS "returnType",
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'mode', COALESCE((procedure.proargmodes)[argument.ordinal]::text, 'i'),
            'name', (procedure.proargnames)[argument.ordinal],
            'type', argument_type.identity
          )
          ORDER BY argument.ordinal
        )
        FROM pg_catalog.unnest(
          COALESCE(procedure.proallargtypes, procedure.proargtypes::oid[])
        ) WITH ORDINALITY AS argument(type_oid, ordinal)
        INNER JOIN type_identity AS argument_type ON argument_type.oid = argument.type_oid
      ), '[]'::jsonb) AS "allArguments"
    FROM pg_catalog.pg_proc AS procedure
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
    INNER JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
    INNER JOIN type_identity AS return_type ON return_type.oid = procedure.prorettype
    WHERE namespace.nspname = 'public'
      AND procedure.proname = ANY(${names}::text[])
    ORDER BY namespace.nspname, procedure.proname, procedure.proargtypes::text
  `;
  return sortedCanonical(rows);
}

function requireExactOverloadSet(rows: readonly CanonicalFunctionRow[], code: string): void {
  requireCondition(rows.length === sourceFunctions.length, code);
  for (const expected of sourceFunctions) {
    const matches = rows.filter((row) => row.name === expected.name);
    requireCondition(
      matches.length === 1
        && JSON.stringify(matches[0]?.inputTypes) === JSON.stringify(expected.inputTypes),
      code,
    );
  }
}

async function applyMigrationStatements(
  sql: ReturnType<typeof postgres>,
  migration: MigrationMeta,
): Promise<void> {
  await sql.begin(async (transaction) => {
    for (const statement of migration.sql) await transaction.unsafe(statement);
  });
}

async function prepareFreshReference(
  databaseUrl: string,
): Promise<Readonly<{
  canonical: readonly CanonicalFunctionRow[];
  pgCatalogHashes: Readonly<Record<string, string>>;
  publicHashes: Readonly<Record<string, string>>;
}>> {
  assertSafeTestDatabaseUrl(databaseUrl, true);
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.unsafe('CREATE SCHEMA "public"');
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END
      $$
    `;
    // Reproduce the established Supabase public-schema default ACL for routines
    // created by the active migration owner. This is why two untouched WP-10
    // routines retain an owner-bound service_role grant on hosted staging.
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`);

    const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
    requireCondition(migrations.length === 13, "WP11_ATTESTATION_LOCAL_MIGRATION_SET_INVALID");
    for (const migration of migrations.slice(0, 12)) await applyMigrationStatements(sql, migration);

    await sql.unsafe('SET search_path = "$user", public');
    const publicRows = await readFunctionDefinitionHashes(sql);
    requireExpectedHashes(publicRows, "publicHash", "WP11_ATTESTATION_FRESH_PUBLIC_HASH_MISMATCH");
    await sql.unsafe("SET search_path = pg_catalog");
    const pgCatalogRows = await readFunctionDefinitionHashes(sql);
    requireExpectedHashes(
      pgCatalogRows,
      "pgCatalogHash",
      "WP11_ATTESTATION_FRESH_PG_CATALOG_HASH_MISMATCH",
    );
    const canonical = await readCanonicalFunctionState(sql);
    requireExactOverloadSet(canonical, "WP11_ATTESTATION_FRESH_OVERLOAD_SET_INVALID");
    return {
      canonical,
      publicHashes: hashMap(publicRows),
      pgCatalogHashes: hashMap(pgCatalogRows),
    };
  } finally {
    await sql.end();
  }
}

async function readStagingSnapshot(
  databaseUrl: string,
): Promise<Readonly<{
  canonical: readonly CanonicalFunctionRow[];
  connectionSearchPath: string;
  pgCatalogHashes: Readonly<Record<string, string>>;
  publicHashes: Readonly<Record<string, string>>;
  untouchedHashes: Readonly<Record<string, string>>;
  writeProbeSqlstate: string;
}>> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connection: {
      application_name: "wp11-phase2-wp10-definition-attestation",
      default_transaction_read_only: true,
      statement_timeout: 60_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });
  let transactionOpen = false;
  try {
    // The hosted direct endpoint does not reliably honor arbitrary StartupMessage
    // parameters. Establish the same connection-level read-only default explicitly
    // while leaving the connection search_path untouched for the first hash set.
    await sql.unsafe("SET SESSION default_transaction_read_only = true");
    const [connection] = await sql<ConnectionStateRow[]>`
      SELECT pg_catalog.current_setting('default_transaction_read_only')::boolean
          AS "defaultReadOnly",
        pg_catalog.current_setting('search_path') AS "searchPath",
        current_user AS "currentRole",
        session_user AS "sessionRole"
    `;
    requireCondition(connection?.defaultReadOnly === true,
      "WP11_ATTESTATION_CONNECTION_DEFAULT_NOT_READ_ONLY");
    requireCondition(connection.currentRole === connection.sessionRole,
      "WP11_ATTESTATION_CONNECTION_ROLE_CHANGED");

    await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const [transaction] = await sql<{
      isolation: string;
      readOnly: boolean;
    }[]>`
      SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
        pg_catalog.current_setting('transaction_read_only')::boolean AS "readOnly"
    `;
    requireCondition(
      transaction?.isolation === "repeatable read" && transaction.readOnly,
      "WP11_ATTESTATION_TRANSACTION_NOT_READ_ONLY",
    );

    const untouchedRows = await readFunctionDefinitionHashes(sql);
    requireExpectedHashes(
      untouchedRows,
      "publicHash",
      "WP11_ATTESTATION_STAGING_UNTOUCHED_HASH_MISMATCH",
    );
    await sql.unsafe('SET LOCAL search_path = "$user", public');
    const publicRows = await readFunctionDefinitionHashes(sql);
    requireExpectedHashes(publicRows, "publicHash", "WP11_ATTESTATION_STAGING_PUBLIC_HASH_MISMATCH");
    await sql.unsafe("SET LOCAL search_path = pg_catalog");
    const pgCatalogRows = await readFunctionDefinitionHashes(sql);
    requireExpectedHashes(
      pgCatalogRows,
      "pgCatalogHash",
      "WP11_ATTESTATION_STAGING_PG_CATALOG_HASH_MISMATCH",
    );

    const canonical = await readCanonicalFunctionState(sql);
    requireExactOverloadSet(canonical, "WP11_ATTESTATION_STAGING_OVERLOAD_SET_INVALID");

    let writeProbeSqlstate = "none";
    await sql.unsafe("SAVEPOINT wp11_phase2_read_only_probe");
    try {
      await sql.unsafe("UPDATE drizzle.__drizzle_migrations SET hash = hash WHERE false");
    } catch (error: unknown) {
      writeProbeSqlstate = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
      await sql.unsafe("ROLLBACK TO SAVEPOINT wp11_phase2_read_only_probe");
    }
    requireCondition(writeProbeSqlstate === "25006", "WP11_ATTESTATION_WRITE_PROBE_INVALID");
    await sql.unsafe("RELEASE SAVEPOINT wp11_phase2_read_only_probe");
    await sql.unsafe("ROLLBACK");
    transactionOpen = false;

    return {
      canonical,
      connectionSearchPath: connection.searchPath,
      untouchedHashes: hashMap(untouchedRows),
      publicHashes: hashMap(publicRows),
      pgCatalogHashes: hashMap(pgCatalogRows),
      writeProbeSqlstate,
    };
  } finally {
    if (transactionOpen) await sql.unsafe("ROLLBACK");
    await sql.end();
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^WP11_ATTESTATION_[A-Z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (/^[0-9A-Z]{5}$/u.test(code)) return `WP11_ATTESTATION_DATABASE_SQLSTATE_${code}`;
  }
  return "WP11_ATTESTATION_UNEXPECTED_FAILURE";
}

async function main(): Promise<void> {
  const stagingUrl = process.env.STAGING_DATABASE_DIRECT_URL;
  const freshUrl = process.env.FRESH_DATABASE_URL;
  requireCondition(Boolean(stagingUrl), "WP11_ATTESTATION_STAGING_DATABASE_DIRECT_URL_REQUIRED");
  requireCondition(Boolean(freshUrl), "WP11_ATTESTATION_FRESH_DATABASE_URL_REQUIRED");

  const fresh = await prepareFreshReference(freshUrl!);
  const staging = await readStagingSnapshot(stagingUrl!);
  const freshCanonicalJson = JSON.stringify(fresh.canonical);
  const stagingCanonicalJson = JSON.stringify(staging.canonical);
  requireCondition(
    stagingCanonicalJson === freshCanonicalJson,
    "WP11_ATTESTATION_CANONICAL_WP10_DRIFT",
  );

  const evidence = {
    code: "WP11_WP10_DEFINITION_IDENTITY_ATTESTED",
    approvedIdentity: { commit: EXPECTED_MAIN_COMMIT, tree: EXPECTED_MAIN_TREE },
    stagingTransaction: {
      connectionDefaultReadOnly: true,
      connectionSearchPath: staging.connectionSearchPath,
      isolation: "repeatable read",
      transactionReadOnly: true,
      writeProbeSqlstate: staging.writeProbeSqlstate,
      end: "ROLLBACK",
      roleChanges: 0,
    },
    hashes: {
      untouched: staging.untouchedHashes,
      publicVisible: staging.publicHashes,
      pgCatalog: staging.pgCatalogHashes,
    },
    canonical: {
      functionCount: staging.canonical.length,
      fingerprint: sha256(stagingCanonicalJson),
      matchesFreshPostgres17At0011: true,
      functions: staging.canonical,
    },
    conclusion: "WP10_UNCHANGED_SEARCH_PATH_QUALIFICATION_ONLY",
  };
  process.stdout.write(`WP11_WP10_ATTESTATION ${JSON.stringify(evidence)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeFailureCode(error)}\n`);
  process.exitCode = 1;
});
