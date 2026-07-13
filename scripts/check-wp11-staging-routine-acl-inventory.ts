import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import {
  assessApprovedPgTrgmManifest,
  canonicalizePostgresExtensionManifest,
  PG_TRGM_EXPECTED_ROUTINE_COUNT,
  PG_TRGM_STAGING_BASELINE,
  type PostgresExtensionAclRow,
  type PostgresExtensionRoutineRow,
  type PostgresExtensionRow,
} from "../src/domain/postgres-extension-manifest";

const EXPECTED_MAIN_COMMIT = "8723114e467e27c515b854b8cf9bb2a6c7be768e";
const EXPECTED_MAIN_TREE = "9f98665d76cae8b235d40f31f955d6985f7c297e";
const EXPECTED_0012_HASH = "b73b6e72ac1d24c1608c1d0844645f8ba23224d42e75dfc9e3c215e73c6dd52a";

const inspectedRoles = [
  "anon",
  "authenticated",
  "service_role",
  "repairprint_submission_service",
  "repairprint_submission_maintenance",
  "repairprint_source_service",
  "repairprint_source_maintenance",
] as const;

const boundaryRoles = [
  "repairprint_submission_service",
  "repairprint_submission_maintenance",
  "repairprint_source_service",
  "repairprint_source_maintenance",
] as const;

const cleanupSignatures = [
  "public.cleanup_expired_submission_intakes(integer)",
  "public.claim_expired_private_media(integer, uuid)",
  "public.complete_private_media_cleanup(uuid, uuid[])",
  "public.claim_private_media_quarantine_cleanup(integer, uuid)",
  "public.complete_private_media_quarantine_cleanup(uuid, uuid[])",
  "public.claim_private_media_pending_object_cleanup(integer, uuid)",
  "public.complete_private_media_pending_object_cleanup(uuid, uuid[])",
] as const;

const sourceFunctionHashes = new Map<string, string>([
  [
    "public.upsert_private_source_candidate(text, text, public.source_candidate_origin, text, jsonb, text, uuid, timestamp with time zone, uuid, text, text, text, text)",
    "028b0dcd590a17876067d450b8810369867f620192446d83668d41dd2d7d088c",
  ],
  [
    "public.transition_source_candidate_version(uuid, public.source_ingestion_stage, public.source_ingestion_stage, uuid, text, text)",
    "d72ac45447578b826832039309e4a44bc4a16fd112e3080e37b3e0be802c22eb",
  ],
  [
    "public.claim_source_link_check_jobs(text, integer, integer)",
    "db0f2f3ea10e878802cfa1653a7df79e3668bcbecec9f09ebc0abc39d0647f5b",
  ],
  [
    "public.complete_source_link_check(uuid, uuid, uuid, integer, text, text, integer, text, integer, timestamp with time zone, text, text)",
    "ec59f97ec0779229f0512033c421ad2224b187be1967f1aa44ea2e4e08915fb9",
  ],
]);

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

interface RoutineRow {
  readonly aclDefaulted: boolean;
  readonly configuration: string[];
  readonly configurationDefaulted: boolean;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly owner: string;
  readonly result: string | null;
  readonly securityDefiner: boolean;
  readonly signature: string;
  readonly triggerOnly: boolean;
}

interface AclRow {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
  readonly signature: string;
}

interface ProvenanceRow {
  readonly configuration: readonly {
    readonly condition: string | null;
    readonly relation: string;
  }[];
  readonly dependencyType: string;
  readonly extension: string;
  readonly owner: string;
  readonly relocatable: boolean;
  readonly schema: string;
  readonly signature: string;
  readonly version: string;
}

interface RolePathRow {
  readonly effectiveExecute: boolean;
  readonly inheritedAclGrantees: string[];
  readonly isOwner: boolean;
  readonly role: string;
  readonly roleExists: boolean;
  readonly schemaUsage: boolean;
  readonly settableAclGrantees: string[];
  readonly signature: string;
  readonly superuser: boolean;
  readonly viaDirect: boolean;
  readonly viaPublic: boolean;
}

interface MembershipRow {
  readonly adminOption: boolean;
  readonly grantedRole: string;
  readonly grantorRole: string | null;
  readonly inheritOption: boolean;
  readonly memberRole: string;
  readonly setOption: boolean;
}

interface RoleAttributeRow {
  readonly bypassRls: boolean;
  readonly canLogin: boolean;
  readonly connectionLimit: number;
  readonly createDb: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly role: string;
  readonly superuser: boolean;
}

interface DefinitionRow {
  readonly definition: string | null;
  readonly exists: boolean;
  readonly kind: string | null;
  readonly signature: string;
}

interface DefaultAclRow {
  readonly aclExists: boolean;
  readonly role: string;
  readonly roleExists: boolean;
  readonly scope: string | null;
}

interface DefaultAclEntryRow extends AclRow {
  readonly role: string;
  readonly scope: string;
}

interface ConnectionStateRow {
  readonly currentRole: string;
  readonly defaultReadOnly: boolean;
  readonly searchPath: string;
  readonly sessionRole: string;
}

interface TransactionStateRow {
  readonly defaultReadOnly: boolean;
  readonly isolation: string;
  readonly readOnly: boolean;
  readonly searchPath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareJson(left: unknown, right: unknown): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

function canonicalizeRoutineConfiguration(settings: readonly string[]) {
  return settings.map((setting) => {
    const separator = setting.indexOf("=");
    const name = separator < 0 ? setting : setting.slice(0, separator);
    const value = separator < 0 ? "" : setting.slice(separator + 1);
    return name === "search_path"
      ? { name, value }
      : { name, valueSha256: sha256(value) };
  }).sort(compareJson);
}

function requireCondition(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function withReadOnlyStartupOptions(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const requiredOptions = "-c default_transaction_read_only=on -c search_path=pg_catalog";
  const existingOptions = parsed.searchParams.get("options")?.trim();
  parsed.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${requiredOptions}` : requiredOptions,
  );
  return parsed.toString();
}

function readExpectedMigrations(): {
  readonly applied: readonly ExpectedMigration[];
  readonly wp11: ExpectedMigration;
} {
  const directory = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    readFileSync(path.join(directory, "meta", "_journal.json"), "utf8"),
  ) as DrizzleJournal;
  const migrations = journal.entries.map((entry) => ({
    tag: entry.tag,
    createdAt: String(entry.when),
    hash: sha256(readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8")),
  }));
  const applied = migrations.filter((migration) => /^00(?:0\d|1[01])_/u.test(migration.tag));
  const wp11 = migrations.find((migration) => migration.tag.startsWith("0012_"));
  requireCondition(applied.length === 12 && wp11 !== undefined, "WP11_INVENTORY_LOCAL_MIGRATION_SET_INVALID");
  requireCondition(wp11.hash === EXPECTED_0012_HASH, "WP11_INVENTORY_LOCAL_0012_HASH_INVALID");
  return { applied, wp11 };
}

function entriesForSignature(rows: readonly AclRow[], signature: string): readonly Omit<AclRow, "signature">[] {
  return rows
    .filter((row) => row.signature === signature)
    .map((row) => ({
      grantor: row.grantor,
      grantee: row.grantee,
      privilege: row.privilege,
      grantable: row.grantable,
    }))
    .sort(compareJson);
}

function pathsForSignature(rows: readonly RolePathRow[], signature: string) {
  return rows
    .filter((row) => row.signature === signature)
    .map((path) => ({
      role: path.role,
      roleExists: path.roleExists,
      effectiveExecute: path.effectiveExecute,
      schemaUsage: path.schemaUsage,
      boundaryCallableNow: path.effectiveExecute && path.schemaUsage,
      viaPublic: path.viaPublic,
      viaDirect: path.viaDirect,
      isOwner: path.isOwner,
      superuser: path.superuser,
      inheritedAclGrantees: [...path.inheritedAclGrantees].sort(compareText),
      settableAclGrantees: [...path.settableAclGrantees].sort(compareText),
    }))
    .sort((left, right) => compareText(left.role, right.role));
}

function requireProviderMembershipPair(
  memberships: readonly MembershipRow[],
  roles: readonly string[],
  code: string,
): void {
  requireCondition(memberships.length === roles.length, code);
  const expected = new Set(roles);
  for (const membership of memberships) {
    requireCondition(expected.delete(membership.grantedRole), code);
    requireCondition(
      membership.memberRole === "postgres"
        && membership.grantorRole === "supabase_admin"
        && membership.adminOption
        && !membership.inheritOption
        && !membership.setOption,
      code,
    );
  }
  requireCondition(expected.size === 0, code);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.STAGING_DATABASE_DIRECT_URL;
  if (!databaseUrl) throw new Error("WP11_INVENTORY_STAGING_DATABASE_DIRECT_URL_REQUIRED");

  const expectedMigrations = readExpectedMigrations();
  const sql = postgres(withReadOnlyStartupOptions(databaseUrl), {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connection: {
      application_name: "wp11-phase1-routine-acl-inventory",
      options: "-c default_transaction_read_only=on -c search_path=pg_catalog",
      statement_timeout: 60_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });

  let transactionOpen = false;
  const output: string[] = [];

  try {
    await sql.unsafe("SET SESSION default_transaction_read_only = true");
    await sql.unsafe("SET SESSION search_path = pg_catalog");
    const [connectionState] = await sql<ConnectionStateRow[]>`
      SELECT pg_catalog.current_setting('default_transaction_read_only')::boolean AS "defaultReadOnly",
        pg_catalog.current_setting('search_path') AS "searchPath",
        current_user AS "currentRole",
        session_user AS "sessionRole"
    `;
    requireCondition(connectionState?.defaultReadOnly === true,
      "WP11_INVENTORY_CONNECTION_DEFAULT_NOT_READ_ONLY");
    requireCondition(connectionState.searchPath === "pg_catalog",
      "WP11_INVENTORY_CONNECTION_SEARCH_PATH_INVALID");
    requireCondition(connectionState.currentRole === connectionState.sessionRole,
      "WP11_INVENTORY_CONNECTION_ROLE_CHANGED");

    await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await sql.unsafe("SET LOCAL search_path = pg_catalog");

    const [transactionState] = await sql<TransactionStateRow[]>`
      SELECT pg_catalog.current_setting('default_transaction_read_only')::boolean AS "defaultReadOnly",
        pg_catalog.current_setting('transaction_isolation') AS isolation,
        pg_catalog.current_setting('transaction_read_only')::boolean AS "readOnly",
        pg_catalog.current_setting('search_path') AS "searchPath"
    `;
    requireCondition(
      transactionState?.defaultReadOnly === true
        && transactionState.readOnly === true
        && transactionState.isolation === "repeatable read"
        && transactionState.searchPath === "pg_catalog",
      "WP11_INVENTORY_TRANSACTION_NOT_READ_ONLY",
    );

    const ledger = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    requireCondition(ledger.length === expectedMigrations.applied.length, "WP11_INVENTORY_LEDGER_COUNT_INVALID");
    for (const [index, expected] of expectedMigrations.applied.entries()) {
      const actual = ledger[index];
      requireCondition(
        actual?.hash === expected.hash && actual.createdAt === expected.createdAt,
        "WP11_INVENTORY_LEDGER_ENTRY_INVALID",
      );
    }
    requireCondition(
      !ledger.some((row) => row.hash === expectedMigrations.wp11.hash
        || row.createdAt === expectedMigrations.wp11.createdAt),
      "WP11_INVENTORY_0012_PRESENT",
    );

    const analyticsResidue = await sql<{ readonly identity: string; readonly kind: string }[]>`
      SELECT 'role'::text AS kind, role.rolname AS identity
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname ~ '^repairprint_analytics_'
      UNION ALL
      SELECT 'relation'::text, pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname ~ '^private_analytics_'
      UNION ALL
      SELECT 'routine'::text, pg_catalog.format('%I.%I(%s)', namespace.nspname,
        procedure.proname, pg_catalog.oidvectortypes(procedure.proargtypes))
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.proname ~ '^record_private_analytics_'
      UNION ALL
      SELECT 'type'::text, pg_catalog.format('%I.%I', namespace.nspname, type_name.typname)
      FROM pg_catalog.pg_type AS type_name
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_name.typnamespace
      WHERE namespace.nspname = 'public' AND type_name.typname ~ '^private_analytics_'
      UNION ALL
      SELECT 'constraint'::text, constraint_name.conname
      FROM pg_catalog.pg_constraint AS constraint_name
      WHERE constraint_name.conname ~ '^private_analytics_'
      UNION ALL
      SELECT 'trigger'::text, trigger_name.tgname
      FROM pg_catalog.pg_trigger AS trigger_name
      WHERE trigger_name.tgname ~ '^private_analytics_'
      UNION ALL
      SELECT 'policy'::text, policy_name.polname
      FROM pg_catalog.pg_policy AS policy_name
      WHERE policy_name.polname ~ '^private_analytics_'
      ORDER BY kind, identity
    `;
    requireCondition(analyticsResidue.length === 0, "WP11_INVENTORY_ANALYTICS_OBJECT_RESIDUE");

    const analyticsMemberships = await sql<{ readonly count: number }[]>`
      SELECT pg_catalog.count(*)::int AS count
      FROM pg_catalog.pg_auth_members AS membership
      INNER JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
      INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname ~ '^repairprint_analytics_'
         OR member.rolname ~ '^repairprint_analytics_'
         OR grantor.rolname ~ '^repairprint_analytics_'
    `;
    requireCondition(analyticsMemberships[0]?.count === 0, "WP11_INVENTORY_ANALYTICS_MEMBERSHIP_RESIDUE");

    const analyticsAcl = await sql<{ readonly count: number }[]>`
      WITH analytics_role AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname ~ '^repairprint_analytics_'
      ), all_acl AS (
        SELECT acl.grantee, acl.grantor FROM pg_catalog.pg_namespace AS object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.nspacl) AS acl
        UNION ALL
        SELECT acl.grantee, acl.grantor FROM pg_catalog.pg_class AS object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) AS acl
        UNION ALL
        SELECT acl.grantee, acl.grantor FROM pg_catalog.pg_proc AS object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.proacl) AS acl
        UNION ALL
        SELECT acl.grantee, acl.grantor FROM pg_catalog.pg_default_acl AS object
        CROSS JOIN LATERAL pg_catalog.aclexplode(object.defaclacl) AS acl
      )
      SELECT pg_catalog.count(*)::int AS count FROM all_acl
      WHERE grantee IN (SELECT oid FROM analytics_role)
         OR grantor IN (SELECT oid FROM analytics_role)
    `;
    requireCondition(analyticsAcl[0]?.count === 0, "WP11_INVENTORY_ANALYTICS_ACL_RESIDUE");

    const routines = await sql<RoutineRow[]>`
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        procedure.proname AS name,
        CASE procedure.prokind
          WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window'
          ELSE procedure.prokind::text
        END AS kind,
        pg_catalog.pg_get_function_result(procedure.oid) AS result,
        procedure.prorettype IN ('pg_catalog.trigger'::pg_catalog.regtype,
          'pg_catalog.event_trigger'::pg_catalog.regtype) AS "triggerOnly",
        owner_role.rolname AS owner,
        language.lanname AS language,
        procedure.prosecdef AS "securityDefiner",
        procedure.proconfig IS NULL AS "configurationDefaulted",
        ARRAY(SELECT setting FROM pg_catalog.unnest(
          COALESCE(procedure.proconfig, ARRAY[]::text[])) AS configured(setting)
          ORDER BY setting COLLATE "C") AS configuration,
        procedure.proacl IS NULL AS "aclDefaulted"
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      INNER JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature
    `;
    requireCondition(routines.length > 0, "WP11_INVENTORY_PUBLIC_ROUTINES_EMPTY");
    requireCondition(new Set(routines.map((row) => row.signature)).size === routines.length,
      "WP11_INVENTORY_DUPLICATE_CANONICAL_SIGNATURE");

    const [publicSchemaBoundary] = await sql<{ readonly usage: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner))) AS acl
        WHERE namespace.nspname = 'public' AND acl.grantee = 0
          AND acl.privilege_type = 'USAGE'
      ) AS usage
    `;
    requireCondition(publicSchemaBoundary !== undefined,
      "WP11_INVENTORY_PUBLIC_SCHEMA_METADATA_MISSING");

    const provenance = await sql<ProvenanceRow[]>`
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        dependency.deptype::text AS "dependencyType",
        extension.extname AS extension,
        extension.extversion AS version,
        extension_namespace.nspname AS schema,
        extension_owner.rolname AS owner,
        extension.extrelocatable AS relocatable,
        COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'relation', pg_catalog.format('%I.%I', configured_namespace.nspname, configured_relation.relname),
            'condition', extension.extcondition[configured.ordinality]
          ) ORDER BY configured.ordinality)
          FROM pg_catalog.unnest(COALESCE(extension.extconfig, ARRAY[]::oid[]))
            WITH ORDINALITY AS configured(relation_oid, ordinality)
          INNER JOIN pg_catalog.pg_class AS configured_relation ON configured_relation.oid = configured.relation_oid
          INNER JOIN pg_catalog.pg_namespace AS configured_namespace
            ON configured_namespace.oid = configured_relation.relnamespace
        ), '[]'::jsonb) AS configuration
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid = procedure.oid AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND dependency.refobjsubid = 0 AND dependency.deptype = 'e'
      INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
      INNER JOIN pg_catalog.pg_namespace AS extension_namespace ON extension_namespace.oid = extension.extnamespace
      INNER JOIN pg_catalog.pg_roles AS extension_owner ON extension_owner.oid = extension.extowner
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature, extension.extname COLLATE "C"
    `;

    const effectiveAcl = await sql<AclRow[]>`
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
        acl.privilege_type AS privilege, acl.is_grantable AS grantable
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner))) AS acl
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature, grantee, grantor, privilege, grantable
    `;

    const storedAcl = await sql<AclRow[]>`
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
        acl.privilege_type AS privilege, acl.is_grantable AS grantable
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature, grantee, grantor, privilege, grantable
    `;
    requireCondition([...effectiveAcl, ...storedAcl].every((entry) =>
      !entry.grantor.startsWith("unknown (") && !entry.grantee.startsWith("unknown (")),
    "WP11_INVENTORY_UNRESOLVED_ROUTINE_ACL_ROLE");

    const rolePaths = await sql<RolePathRow[]>`
      WITH requested(role_name) AS (
        SELECT pg_catalog.unnest(${inspectedRoles as unknown as string[]}::text[])
      ), inspected AS (
        SELECT requested.role_name, role.oid, role.rolsuper
        FROM requested LEFT JOIN pg_catalog.pg_roles AS role ON role.rolname = requested.role_name
      )
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        inspected.role_name AS role, inspected.oid IS NOT NULL AS "roleExists",
        COALESCE(pg_catalog.has_function_privilege(inspected.oid, procedure.oid, 'EXECUTE'), false) AS "effectiveExecute",
        COALESCE(pg_catalog.has_schema_privilege(inspected.oid, namespace.oid, 'USAGE'), false) AS "schemaUsage",
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "viaPublic",
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = inspected.oid AND acl.privilege_type = 'EXECUTE') AS "viaDirect",
        inspected.oid = procedure.proowner AS "isOwner",
        COALESCE(inspected.rolsuper, false) AS superuser,
        ARRAY(SELECT acl_role.rolname
          FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner))) AS acl
          INNER JOIN pg_catalog.pg_roles AS acl_role ON acl_role.oid = acl.grantee
          WHERE inspected.oid IS NOT NULL AND acl.grantee <> inspected.oid
            AND acl.privilege_type = 'EXECUTE'
            AND pg_catalog.pg_has_role(inspected.oid, acl.grantee, 'USAGE')
          ORDER BY acl_role.rolname COLLATE "C") AS "inheritedAclGrantees",
        ARRAY(SELECT acl_role.rolname
          FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner))) AS acl
          INNER JOIN pg_catalog.pg_roles AS acl_role ON acl_role.oid = acl.grantee
          WHERE inspected.oid IS NOT NULL AND acl.grantee <> inspected.oid
            AND acl.privilege_type = 'EXECUTE'
            AND pg_catalog.pg_has_role(inspected.oid, acl.grantee, 'SET')
          ORDER BY acl_role.rolname COLLATE "C") AS "settableAclGrantees"
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN inspected
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature, role
    `;
    requireCondition(rolePaths.length === routines.length * inspectedRoles.length,
      "WP11_INVENTORY_ROLE_PATH_MATRIX_INCOMPLETE");

    const routineInventory = routines.map((routine) => {
      const extensionProvenance = provenance
        .filter((row) => row.signature === routine.signature)
        .map((entry) => ({
          dependencyType: entry.dependencyType,
          extension: entry.extension,
          version: entry.version,
          schema: entry.schema,
          owner: entry.owner,
          relocatable: entry.relocatable,
          configuration: entry.configuration.map((configured) => ({
            relation: configured.relation,
            conditionSha256: configured.condition === null ? null : sha256(configured.condition),
          })).sort(compareJson),
        }))
        .sort(compareJson);
      return {
        signature: routine.signature,
        kind: routine.kind,
        returnType: routine.result,
        triggerOnly: routine.triggerOnly,
        owner: routine.owner,
        language: routine.language,
        securityDefiner: routine.securityDefiner,
        configurationDefaulted: routine.configurationDefaulted,
        configuration: canonicalizeRoutineConfiguration(routine.configuration),
        searchPath: routine.configuration.filter((entry) => entry.startsWith("search_path=")),
        aclDefaulted: routine.aclDefaulted,
        acl: entriesForSignature(effectiveAcl, routine.signature),
        storedAcl: entriesForSignature(storedAcl, routine.signature),
        extensionProvenance,
        execution: pathsForSignature(rolePaths, routine.signature).map((path) => ({
          ...path,
          boundaryCallableNow: path.boundaryCallableNow && !routine.triggerOnly,
        })),
      };
    }).sort((left, right) => compareText(left.signature, right.signature));
    const routineManifest = { version: 1, routines: routineInventory } as const;
    const routineFingerprint = sha256(JSON.stringify(routineManifest));

    const publicApplicationExecute = routineInventory
      .filter((routine) => !routine.triggerOnly
        && routine.extensionProvenance.length === 0
        && routine.acl.some((entry) => entry.grantee === "PUBLIC" && entry.privilege === "EXECUTE"))
      .map((routine) => ({
        signature: routine.signature,
        kind: routine.kind,
        owner: routine.owner,
        securityDefiner: routine.securityDefiner,
        aclDefaulted: routine.aclDefaulted,
        storedPublicExecute: routine.storedAcl.some((entry) => entry.grantee === "PUBLIC"
          && entry.privilege === "EXECUTE"),
        publicSchemaUsage: publicSchemaBoundary.usage,
        publicCallableNow: publicSchemaBoundary.usage,
      }));
    const otherExtensionRoutines = routineInventory
      .filter((routine) => routine.extensionProvenance.some((entry) => entry.extension !== "pg_trgm"))
      .map((routine) => ({ signature: routine.signature, provenance: routine.extensionProvenance }));

    const cleanupDefinitions = await sql<DefinitionRow[]>`
      WITH expected(signature) AS (
        SELECT pg_catalog.unnest(${cleanupSignatures as unknown as string[]}::text[])
      )
      SELECT CASE WHEN procedure.oid IS NULL THEN expected.signature
        ELSE pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) END AS signature,
        procedure.oid IS NOT NULL AS exists,
        CASE procedure.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE procedure.prokind::text END AS kind,
        CASE WHEN procedure.prokind IN ('f', 'p')
          THEN pg_catalog.pg_get_functiondef(procedure.oid) ELSE NULL END AS definition
      FROM expected
      LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = pg_catalog.to_regprocedure(expected.signature)::oid
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      ORDER BY expected.signature COLLATE "C"
    `;
    requireCondition(cleanupDefinitions.length === cleanupSignatures.length
      && cleanupDefinitions.every((row) => row.exists && row.kind === "function" && row.definition !== null),
      "WP11_INVENTORY_CLEANUP_ROUTINE_MISSING");

    const cleanupAllRolePaths = await sql<RolePathRow[]>`
      WITH expected(signature) AS (
        SELECT pg_catalog.unnest(${cleanupSignatures as unknown as string[]}::text[])
      ), cleanup AS (
        SELECT procedure.*
        FROM expected
        INNER JOIN pg_catalog.pg_proc AS procedure
          ON procedure.oid = pg_catalog.to_regprocedure(expected.signature)::oid
      )
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) AS signature,
        inspected.rolname AS role, true AS "roleExists",
        pg_catalog.has_function_privilege(inspected.oid, procedure.oid, 'EXECUTE') AS "effectiveExecute",
        pg_catalog.has_schema_privilege(inspected.oid, namespace.oid, 'USAGE') AS "schemaUsage",
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "viaPublic",
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = inspected.oid AND acl.privilege_type = 'EXECUTE') AS "viaDirect",
        inspected.oid = procedure.proowner AS "isOwner", inspected.rolsuper AS superuser,
        ARRAY(SELECT acl_role.rolname
          FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner))) AS acl
          INNER JOIN pg_catalog.pg_roles AS acl_role ON acl_role.oid = acl.grantee
          WHERE acl.grantee <> inspected.oid AND acl.privilege_type = 'EXECUTE'
            AND pg_catalog.pg_has_role(inspected.oid, acl.grantee, 'USAGE')
          ORDER BY acl_role.rolname COLLATE "C") AS "inheritedAclGrantees",
        ARRAY(SELECT acl_role.rolname
          FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner))) AS acl
          INNER JOIN pg_catalog.pg_roles AS acl_role ON acl_role.oid = acl.grantee
          WHERE acl.grantee <> inspected.oid AND acl.privilege_type = 'EXECUTE'
            AND pg_catalog.pg_has_role(inspected.oid, acl.grantee, 'SET')
          ORDER BY acl_role.rolname COLLATE "C") AS "settableAclGrantees"
      FROM cleanup AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN pg_catalog.pg_roles AS inspected
      ORDER BY signature, role
    `;
    requireCondition(cleanupAllRolePaths.length >= cleanupDefinitions.length,
      "WP11_INVENTORY_CLEANUP_ROLE_PATHS_INCOMPLETE");

    const cleanupNames = cleanupSignatures.map((signature) => signature.slice("public.".length, signature.indexOf("(")));
    const cleanupOverloads = routines
      .filter((routine) => cleanupNames.includes(routine.name)
        && !cleanupDefinitions.some((expected) => expected.signature === routine.signature))
      .map((routine) => routine.signature)
      .sort(compareText);

    const cleanupEvidence = cleanupDefinitions.map((definition) => {
      const routine = routineInventory.find((candidate) => candidate.signature === definition.signature);
      requireCondition(routine !== undefined && definition.definition !== null,
        "WP11_INVENTORY_CLEANUP_METADATA_INCOMPLETE");
      const directServiceGrants = routine.storedAcl.filter((entry) => entry.grantee === "repairprint_submission_service"
        && entry.privilege === "EXECUTE");
      const submissionPath = routine.execution.find((entry) => entry.role === "repairprint_submission_service");
      const anonPath = routine.execution.find((entry) => entry.role === "anon");
      const authenticatedPath = routine.execution.find((entry) => entry.role === "authenticated");
      const routineName = routine.signature.slice("public.".length, routine.signature.indexOf("("));
      return {
        signature: routine.signature,
        owner: routine.owner,
        definitionSha256: sha256(definition.definition),
        securityDefiner: routine.securityDefiner,
        configuration: routine.configuration,
        searchPath: routine.searchPath,
        aclDefaulted: routine.aclDefaulted,
        acl: routine.acl,
        storedAcl: routine.storedAcl,
        execution: routine.execution,
        allRoleExecution: pathsForSignature(cleanupAllRolePaths, routine.signature),
        publicExecute: routine.acl.some((entry) => entry.grantee === "PUBLIC" && entry.privilege === "EXECUTE"),
        publicSchemaUsage: publicSchemaBoundary.usage,
        publicCallableNow: publicSchemaBoundary.usage
          && routine.acl.some((entry) => entry.grantee === "PUBLIC" && entry.privilege === "EXECUTE")
          && !routine.triggerOnly,
        anonExecute: anonPath?.boundaryCallableNow ?? false,
        authenticatedExecute: authenticatedPath?.boundaryCallableNow ?? false,
        submissionServiceDirectGrants: directServiceGrants,
        submissionServiceOwnerBoundGrant: directServiceGrants.length === 1
          && directServiceGrants[0]?.grantor === routine.owner
          && directServiceGrants[0].grantable === false,
        submissionServiceMerelyPublic: submissionPath?.effectiveExecute === true
          && directServiceGrants.length === 0
          && submissionPath.viaPublic
          && submissionPath.inheritedAclGrantees.length === 0
          && !submissionPath.isOwner
          && !submissionPath.superuser,
        serviceRoleDirectGrants: routine.storedAcl.filter((entry) => entry.grantee === "service_role"
          && entry.privilege === "EXECUTE"),
        unexpectedOverloads: cleanupOverloads.filter((signature) =>
          signature.startsWith(`public.${routineName}(`)),
      };
    });

    const sourceSignatures = [...sourceFunctionHashes.keys()];
    const sourceDefinitions = await sql<DefinitionRow[]>`
      WITH expected(signature) AS (
        SELECT pg_catalog.unnest(${sourceSignatures}::text[])
      )
      SELECT CASE WHEN procedure.oid IS NULL THEN expected.signature
        ELSE pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.oidvectortypes(procedure.proargtypes)) END AS signature,
        procedure.oid IS NOT NULL AS exists,
        CASE procedure.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE procedure.prokind::text END AS kind,
        CASE WHEN procedure.prokind IN ('f', 'p')
          THEN pg_catalog.pg_get_functiondef(procedure.oid) ELSE NULL END AS definition
      FROM expected
      LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = pg_catalog.to_regprocedure(expected.signature)::oid
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      ORDER BY expected.signature COLLATE "C"
    `;
    requireCondition(sourceDefinitions.length === sourceFunctionHashes.size
      && sourceDefinitions.every((row) => row.exists && row.kind === "function" && row.definition !== null),
      "WP11_INVENTORY_WP10_FUNCTION_MISSING");

    const wp10Functions = sourceDefinitions.map((definition) => {
      const routine = routineInventory.find((candidate) => candidate.signature === definition.signature);
      requireCondition(routine !== undefined && definition.definition !== null,
        "WP11_INVENTORY_WP10_METADATA_INCOMPLETE");
      const definitionSha256 = sha256(definition.definition);
      const expectedHash = sourceFunctionHashes.get(definition.signature);
      const servicePath = routine.execution.find((entry) => entry.role === "repairprint_source_service");
      const anonPath = routine.execution.find((entry) => entry.role === "anon");
      const authenticatedPath = routine.execution.find((entry) => entry.role === "authenticated");
      const publicExecute = routine.acl.some((entry) => entry.grantee === "PUBLIC"
        && entry.privilege === "EXECUTE");
      const serviceDirectGrants = routine.storedAcl.filter((entry) =>
        entry.grantee === "repairprint_source_service" && entry.privilege === "EXECUTE");
      const expectedAcl = [
        { grantor: "repairprint_source_maintenance", grantee: "repairprint_source_maintenance", privilege: "EXECUTE", grantable: false },
        { grantor: "repairprint_source_maintenance", grantee: "repairprint_source_service", privilege: "EXECUTE", grantable: false },
      ].sort(compareJson);
      const valid = definitionSha256 === expectedHash
        && routine.owner === "repairprint_source_maintenance"
        && routine.securityDefiner
        && JSON.stringify(routine.searchPath) === JSON.stringify(["search_path=pg_catalog"])
        && routine.configuration.length === 1
        && !publicExecute
        && servicePath?.boundaryCallableNow === true
        && anonPath?.boundaryCallableNow === false
        && authenticatedPath?.boundaryCallableNow === false
        && serviceDirectGrants.length === 1
        && serviceDirectGrants[0]?.grantor === "repairprint_source_maintenance"
        && serviceDirectGrants[0].grantable === false;
      return {
        signature: routine.signature,
        valid,
        definitionSha256,
        owner: routine.owner,
        securityDefiner: routine.securityDefiner,
        configuration: routine.configuration,
        searchPath: routine.searchPath,
        acl: routine.acl,
        storedAcl: routine.storedAcl,
        publicExecute,
        serviceDirectGrants,
        exactExpectedAclShape: JSON.stringify(routine.acl) === JSON.stringify(expectedAcl),
        serviceExecution: servicePath,
      };
    });
    const extraSourceGrants = storedAcl.filter((entry) => entry.grantee === "repairprint_source_service"
      && entry.privilege === "EXECUTE" && !sourceSignatures.includes(entry.signature));
    requireCondition(extraSourceGrants.length === 0, "WP11_INVENTORY_WP10_EXTRA_FUNCTION_GRANT");
    const sourceFunctionNames = sourceSignatures.map((signature) =>
      signature.slice("public.".length, signature.indexOf("(")));
    const unexpectedSourceOverloads = routines
      .filter((routine) => sourceFunctionNames.includes(routine.name)
        && !sourceSignatures.includes(routine.signature))
      .map((routine) => routine.signature)
      .sort(compareText);
    requireCondition(unexpectedSourceOverloads.length === 0,
      "WP11_INVENTORY_WP10_UNEXPECTED_OVERLOAD");

    const roleAttributes = await sql<RoleAttributeRow[]>`
      SELECT role.rolname AS role, role.rolcanlogin AS "canLogin", role.rolsuper AS superuser,
        role.rolcreatedb AS "createDb", role.rolcreaterole AS "createRole", role.rolinherit AS inherit,
        role.rolreplication AS replication, role.rolbypassrls AS "bypassRls",
        role.rolconnlimit AS "connectionLimit"
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ANY(${boundaryRoles as unknown as string[]}::text[])
      ORDER BY role.rolname COLLATE "C"
    `;
    requireCondition(roleAttributes.length === boundaryRoles.length
      && roleAttributes.every((role) => !role.superuser && !role.createDb && !role.createRole
        && !role.inherit && !role.replication && !role.bypassRls
        && (role.role === "repairprint_source_service" ? role.canLogin : true)
        && (role.role.endsWith("_maintenance") ? !role.canLogin : true)),
      "WP11_INVENTORY_APPLICATION_ROLE_ATTRIBUTES_CHANGED");

    const memberships = await sql<MembershipRow[]>`
      SELECT granted.rolname AS "grantedRole", member.rolname AS "memberRole",
        grantor.rolname AS "grantorRole", membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption", membership.set_option AS "setOption"
      FROM pg_catalog.pg_auth_members AS membership
      INNER JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
      INNER JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = ANY(${boundaryRoles as unknown as string[]}::text[])
         OR member.rolname = ANY(${boundaryRoles as unknown as string[]}::text[])
      ORDER BY granted.rolname COLLATE "C", member.rolname COLLATE "C", grantor.rolname COLLATE "C"
    `;
    const submissionMemberships = memberships.filter((row) => row.grantedRole.startsWith("repairprint_submission_")
      || row.memberRole.startsWith("repairprint_submission_"));
    const sourceMemberships = memberships.filter((row) => row.grantedRole.startsWith("repairprint_source_")
      || row.memberRole.startsWith("repairprint_source_"));
    requireProviderMembershipPair(submissionMemberships,
      ["repairprint_submission_service", "repairprint_submission_maintenance"],
      "WP11_INVENTORY_SUBMISSION_MEMBERSHIPS_CHANGED");
    requireProviderMembershipPair(sourceMemberships,
      ["repairprint_source_service", "repairprint_source_maintenance"],
      "WP11_INVENTORY_SOURCE_MEMBERSHIPS_CHANGED");

    const defaultAclOwners = [...new Set([
      "postgres", "supabase_admin", "repairprint_submission_maintenance",
      "repairprint_source_maintenance", connectionState.currentRole,
    ])].sort(compareText);
    const defaultAclRows = await sql<DefaultAclRow[]>`
      WITH requested(role_name) AS (
        SELECT pg_catalog.unnest(${defaultAclOwners}::text[])
      )
      SELECT requested.role_name AS role, owner_role.oid IS NOT NULL AS "roleExists",
        default_acl.oid IS NOT NULL AS "aclExists",
        CASE WHEN default_acl.oid IS NULL THEN NULL
          WHEN default_acl.defaclnamespace = 0 THEN 'GLOBAL'
          ELSE namespace.nspname END AS scope
      FROM requested
      LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.rolname = requested.role_name
      LEFT JOIN pg_catalog.pg_default_acl AS default_acl
        ON default_acl.defaclrole = owner_role.oid AND default_acl.defaclobjtype = 'f'
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
      ORDER BY role, scope NULLS FIRST
    `;
    requireCondition(defaultAclOwners.every((owner) => defaultAclRows.some((row) => row.role === owner)),
      "WP11_INVENTORY_DEFAULT_ACL_OWNER_MISSING");
    const defaultAclEntries = await sql<DefaultAclEntryRow[]>`
      SELECT owner_role.rolname AS role,
        CASE WHEN default_acl.defaclnamespace = 0 THEN 'GLOBAL' ELSE namespace.nspname END AS scope,
        ''::text AS signature, pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
        acl.privilege_type AS privilege, acl.is_grantable AS grantable
      FROM pg_catalog.pg_default_acl AS default_acl
      INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = default_acl.defaclrole
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
      WHERE default_acl.defaclobjtype = 'f' AND owner_role.rolname = ANY(${defaultAclOwners}::text[])
      ORDER BY role, scope, grantee, grantor, privilege
    `;
    const builtInDefaultAclEntries = await sql<DefaultAclEntryRow[]>`
      WITH requested(role_name) AS (
        SELECT pg_catalog.unnest(${defaultAclOwners}::text[])
      )
      SELECT owner_role.rolname AS role, 'BUILT_IN'::text AS scope, ''::text AS signature,
        pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
        acl.privilege_type AS privilege, acl.is_grantable AS grantable
      FROM requested
      INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.rolname = requested.role_name
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        pg_catalog.acldefault('f', owner_role.oid)) AS acl
      ORDER BY role, grantee, grantor, privilege
    `;
    requireCondition([...defaultAclEntries, ...builtInDefaultAclEntries].every((entry) =>
      !entry.grantor.startsWith("unknown (") && !entry.grantee.startsWith("unknown (")),
    "WP11_INVENTORY_UNRESOLVED_DEFAULT_ACL_ROLE");
    const defaultAclInventory = defaultAclOwners.map((owner) => ({
      role: owner,
      roleExists: defaultAclRows.some((row) => row.role === owner && row.roleExists),
      globalDefaultRowExists: defaultAclRows.some((row) =>
        row.role === owner && row.aclExists && row.scope === "GLOBAL"),
      usesBuiltInPublicExecuteDefault: defaultAclRows.some((row) => row.role === owner && row.roleExists)
        && !defaultAclRows.some((row) => row.role === owner && row.aclExists && row.scope === "GLOBAL"),
      builtInAcl: builtInDefaultAclEntries.filter((entry) => entry.role === owner)
        .map((entry) => ({
          grantor: entry.grantor,
          grantee: entry.grantee,
          privilege: entry.privilege,
          grantable: entry.grantable,
        }))
        .sort(compareJson),
      rows: defaultAclRows
        .filter((row) => row.role === owner && row.aclExists && row.scope !== null)
        .map((row) => ({
          scope: row.scope,
          acl: defaultAclEntries.filter((entry) => entry.role === owner && entry.scope === row.scope)
            .map((entry) => ({
              grantor: entry.grantor,
              grantee: entry.grantee,
              privilege: entry.privilege,
              grantable: entry.grantable,
            }))
            .sort(compareJson),
        }))
        .sort(compareJson),
    }));

    const pgTrgmExtensions = await sql<PostgresExtensionRow[]>`
      SELECT extension.extname AS name, extension.extversion AS version,
        namespace.nspname AS schema, owner_role.rolname AS owner,
        extension.extrelocatable AS relocatable, extension.extconfig::text[] AS configuration,
        extension.extcondition AS conditions
      FROM pg_catalog.pg_extension AS extension
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
      INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = extension.extowner
      WHERE extension.extname = 'pg_trgm'
    `;
    requireCondition(pgTrgmExtensions.length === 1 && pgTrgmExtensions[0] !== undefined,
      "WP11_INVENTORY_PG_TRGM_EXTENSION_INVALID");
    const pgTrgmRoutines = await sql<PostgresExtensionRoutineRow[]>`
      SELECT namespace.nspname AS schema,
        pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.pg_get_function_identity_arguments(procedure.oid)) AS signature,
        pg_catalog.pg_get_function_result(procedure.oid) AS result,
        owner_role.rolname AS owner, language.lanname AS language,
        CASE procedure.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
          WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE procedure.prokind::text END AS kind,
        procedure.prosecdef AS "securityDefiner",
        CASE procedure.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable'
          WHEN 'v' THEN 'volatile' ELSE procedure.provolatile::text END AS volatility,
        CASE procedure.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted'
          WHEN 'u' THEN 'unsafe' ELSE procedure.proparallel::text END AS parallel,
        procedure.proleakproof AS leakproof, procedure.proisstrict AS strict,
        procedure.proretset AS "returnsSet", procedure.proconfig AS configuration,
        pg_catalog.pg_get_functiondef(procedure.oid) AS definition,
        procedure.proacl IS NULL AS "aclDefaulted"
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      INNER JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
      INNER JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid = procedure.oid AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND dependency.refobjsubid = 0 AND dependency.deptype = 'e'
      INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE extension.extname = 'pg_trgm'
      ORDER BY signature
    `;
    const pgTrgmAcl = await sql<PostgresExtensionAclRow[]>`
      SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_catalog.pg_get_function_identity_arguments(procedure.oid)) AS signature,
        pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
        CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
        acl.privilege_type AS privilege, acl.is_grantable AS grantable
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid = procedure.oid AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND dependency.refobjsubid = 0 AND dependency.deptype = 'e'
      INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner))) AS acl
      WHERE extension.extname = 'pg_trgm'
      ORDER BY signature, grantee, grantor, privilege
    `;
    const pgTrgmManifest = canonicalizePostgresExtensionManifest(
      pgTrgmExtensions[0], pgTrgmRoutines, pgTrgmAcl,
    );
    const pgTrgmAssessment = assessApprovedPgTrgmManifest(pgTrgmManifest);
    requireCondition(pgTrgmAssessment.valid
      && pgTrgmAssessment.routineCount === PG_TRGM_EXPECTED_ROUTINE_COUNT
      && pgTrgmAssessment.routineCount === PG_TRGM_STAGING_BASELINE.routineCount
      && pgTrgmAssessment.fingerprint === PG_TRGM_STAGING_BASELINE.fingerprint
      && pgTrgmManifest.extension.version === "1.6"
      && pgTrgmManifest.extension.schema === "public",
      "WP11_INVENTORY_PG_TRGM_BASELINE_CHANGED");

    let writeProbeCode: string | undefined;
    await sql.unsafe("SAVEPOINT wp11_phase1_read_only_probe");
    try {
      await sql.unsafe("UPDATE drizzle.__drizzle_migrations SET hash = hash WHERE false");
    } catch (error: unknown) {
      writeProbeCode = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      await sql.unsafe("ROLLBACK TO SAVEPOINT wp11_phase1_read_only_probe");
    }
    requireCondition(writeProbeCode === "25006", "WP11_INVENTORY_WRITE_PROBE_INVALID");
    await sql.unsafe("RELEASE SAVEPOINT wp11_phase1_read_only_probe");

    const ledgerAfterProbe = await sql<LedgerRow[]>`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    requireCondition(JSON.stringify(ledgerAfterProbe) === JSON.stringify(ledger),
      "WP11_INVENTORY_LEDGER_CHANGED");

    await sql.unsafe("ROLLBACK");
    transactionOpen = false;

    const summary = {
      code: "WP11_STAGING_ROUTINE_ACL_READ_ONLY_INVENTORY_VERIFIED",
      approvedIdentity: { commit: EXPECTED_MAIN_COMMIT, tree: EXPECTED_MAIN_TREE },
      transaction: {
        connectionDefaultReadOnly: connectionState.defaultReadOnly,
        explicitReadOnly: transactionState.readOnly,
        isolation: transactionState.isolation,
        searchPath: transactionState.searchPath,
        writeProbeSqlstate: writeProbeCode,
        ledgerSnapshotStable: true,
        end: "ROLLBACK",
      },
      ledger: expectedMigrations.applied.map(({ tag, hash }) => ({ tag, hash })),
      migration0012: { ledgered: false, localSha256: expectedMigrations.wp11.hash },
      analyticsResidue: { objects: 0, memberships: 0, aclEntries: 0 },
      publicRoutineInventory: {
        count: routineInventory.length,
        fingerprint: routineFingerprint,
        publicApplicationExecuteCount: publicApplicationExecute.length,
        otherExtensionRoutineCount: otherExtensionRoutines.length,
      },
      cleanup: { expectedCount: cleanupEvidence.length, unexpectedOverloads: cleanupOverloads },
      pgTrgm: {
        version: pgTrgmManifest.extension.version,
        schema: pgTrgmManifest.extension.schema,
        owner: pgTrgmManifest.extension.owner,
        routineCount: pgTrgmAssessment.routineCount,
        fingerprint: pgTrgmAssessment.fingerprint,
      },
      wp10: { valid: wp10Functions.every((routine) => routine.valid) },
      activeMigrationRole: connectionState.currentRole,
    };
    output.push(`WP11_INVENTORY_SUMMARY ${JSON.stringify(summary)}`);
    for (const routine of routineInventory) {
      output.push(`WP11_PUBLIC_ROUTINE ${JSON.stringify(routine)}`);
    }
    output.push(`WP11_PUBLIC_APPLICATION_EXECUTE ${JSON.stringify(publicApplicationExecute)}`);
    output.push(`WP11_OTHER_EXTENSION_ROUTINES ${JSON.stringify(otherExtensionRoutines)}`);
    for (const cleanup of cleanupEvidence) {
      output.push(`WP11_CLEANUP_ROUTINE ${JSON.stringify(cleanup)}`);
    }
    output.push(`WP11_DEFAULT_FUNCTION_ACL ${JSON.stringify({
      fingerprint: sha256(JSON.stringify(defaultAclInventory)),
      owners: defaultAclInventory,
    })}`);
    output.push(`WP11_APPLICATION_ROLES ${JSON.stringify({ attributes: roleAttributes, memberships })}`);
    output.push(`WP11_WP10_BOUNDARY ${JSON.stringify({
      valid: wp10Functions.every((routine) => routine.valid),
      functions: wp10Functions,
      extraSourceFunctionGrants: extraSourceGrants,
      unexpectedOverloads: unexpectedSourceOverloads,
      memberships: sourceMemberships,
    })}`);
  } finally {
    if (transactionOpen) await sql.unsafe("ROLLBACK");
    await sql.end();
  }

  for (const line of output) console.log(line);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("WP11_INVENTORY_")) {
    console.error(message);
  } else if (typeof error === "object" && error !== null && "code" in error) {
    console.error(`WP11_INVENTORY_DATABASE_ERROR:${String(error.code)}`);
  } else {
    console.error("WP11_INVENTORY_FAILED");
  }
  process.exitCode = 1;
});
