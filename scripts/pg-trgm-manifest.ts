import postgres from "postgres";

import {
  assessApprovedPgTrgmManifest,
  canonicalizePostgresExtensionManifest,
  type ApprovedPgTrgmManifestAssessment,
  type CanonicalPostgresExtensionManifest,
  type PostgresExtensionAclRow,
  type PostgresExtensionRoutineRow,
  type PostgresExtensionRow,
} from "../src/domain/postgres-extension-manifest";
import type { AnalyticsPublicRoutineBoundary } from "../src/domain/analytics-routine-boundary";

export interface PgTrgmManifestEvidence {
  readonly assessment: ApprovedPgTrgmManifestAssessment;
  readonly manifest: CanonicalPostgresExtensionManifest;
}

interface PublicRoutineRow {
  readonly directlyGranted: boolean;
  readonly effectiveExecute: boolean;
  readonly pgTrgm: boolean;
  readonly signature: string;
  readonly triggerReturn: boolean;
}

async function readCanonicalPgTrgmManifest(
  transaction: postgres.TransactionSql,
): Promise<CanonicalPostgresExtensionManifest> {
  const extensions = await transaction<PostgresExtensionRow[]>`
    SELECT extension.extname AS name,
      extension.extversion AS version,
      namespace.nspname AS schema,
      owner_role.rolname AS owner,
      extension.extrelocatable AS relocatable,
      extension.extconfig::text[] AS configuration,
      extension.extcondition AS conditions
    FROM pg_catalog.pg_extension AS extension
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = extension.extowner
    WHERE extension.extname = 'pg_trgm'
  `;
  if (extensions.length !== 1 || !extensions[0]) {
    throw new Error("PG_TRGM_EXTENSION_COUNT_INVALID");
  }

  const routines = await transaction<PostgresExtensionRoutineRow[]>`
    SELECT namespace.nspname AS schema,
      format('%I.%I(%s)', namespace.nspname, procedure.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid)) AS signature,
      pg_catalog.pg_get_function_result(procedure.oid) AS result,
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
      pg_catalog.pg_get_functiondef(procedure.oid) AS definition,
      procedure.proacl IS NULL AS "aclDefaulted"
    FROM pg_catalog.pg_proc AS procedure
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    INNER JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
    INNER JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
    WHERE extension.extname = 'pg_trgm'
    ORDER BY signature
  `;

  const acl = await transaction<PostgresExtensionAclRow[]>`
    SELECT format('%I.%I(%s)', namespace.nspname, procedure.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid)) AS signature,
      pg_catalog.pg_get_userbyid(exploded.grantor) AS grantor,
      CASE exploded.grantee
        WHEN 0 THEN 'PUBLIC'
        ELSE pg_catalog.pg_get_userbyid(exploded.grantee)
      END AS grantee,
      exploded.privilege_type AS privilege,
      exploded.is_grantable AS grantable
    FROM pg_catalog.pg_proc AS procedure
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    INNER JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = procedure.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'e'
    INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS exploded
    WHERE extension.extname = 'pg_trgm'
    ORDER BY signature, grantee, grantor, privilege, grantable
  `;

  return canonicalizePostgresExtensionManifest(extensions[0], routines, acl);
}

export async function inspectPgTrgmManifest(
  sql: postgres.Sql,
): Promise<PgTrgmManifestEvidence> {
  return sql.begin("isolation level repeatable read read only", async (transaction) => {
    await transaction.unsafe("SET LOCAL search_path = pg_catalog");
    const manifest = await readCanonicalPgTrgmManifest(transaction);
    return Object.freeze({
      manifest,
      assessment: assessApprovedPgTrgmManifest(manifest),
    });
  });
}

export async function inspectPublicRoutineBoundary(
  sql: postgres.Sql,
  roleName: string,
): Promise<AnalyticsPublicRoutineBoundary> {
  return sql.begin("isolation level repeatable read read only", async (transaction) => {
    await transaction.unsafe("SET LOCAL search_path = pg_catalog");
    const routines = await transaction<PublicRoutineRow[]>`
      WITH inspected_role AS (
        SELECT role.oid
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${roleName}
      )
      SELECT format(
          '%I.%I(%s)',
          namespace.nspname,
          procedure.proname,
          CASE WHEN provenance.is_pg_trgm
            THEN pg_catalog.pg_get_function_identity_arguments(procedure.oid)
            ELSE pg_catalog.oidvectortypes(procedure.proargtypes)
          END
        ) AS signature,
        procedure.prorettype IN (
          'pg_catalog.trigger'::pg_catalog.regtype,
          'pg_catalog.event_trigger'::pg_catalog.regtype
        ) AS "triggerReturn",
        provenance.is_pg_trgm AS "pgTrgm",
        pg_catalog.has_function_privilege(
          (SELECT oid FROM inspected_role), procedure.oid, 'EXECUTE'
        ) AS "effectiveExecute",
        EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (SELECT oid FROM inspected_role)
            AND acl.privilege_type = 'EXECUTE'
        ) AS "directlyGranted"
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = procedure.oid
            AND dependency.objsubid = 0
            AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
            AND dependency.refobjsubid = 0
            AND dependency.deptype = 'e'
            AND extension.extname = 'pg_trgm'
        ) AS is_pg_trgm
      ) AS provenance
      WHERE namespace.nspname = 'public'
        AND procedure.prokind IN ('f', 'p', 'a', 'w')
      ORDER BY signature
    `;

    if (routines.length === 0) throw new Error("PUBLIC_ROUTINE_BOUNDARY_EMPTY");
    return Object.freeze({
      directApplicationGrants: Object.freeze(routines
        .filter((routine) => routine.directlyGranted && !routine.pgTrgm)
        .map((routine) => routine.signature)),
      directPgTrgmGrants: Object.freeze(routines
        .filter((routine) => routine.directlyGranted && routine.pgTrgm)
        .map((routine) => routine.signature)),
      effectiveApplicationRoutines: Object.freeze(routines
        .filter((routine) => routine.effectiveExecute && !routine.pgTrgm && !routine.triggerReturn)
        .map((routine) => routine.signature)),
      effectivePgTrgmRoutines: Object.freeze(routines
        .filter((routine) => routine.effectiveExecute && routine.pgTrgm)
        .map((routine) => routine.signature)),
      nonCallableTriggerRoutines: Object.freeze(routines
        .filter((routine) => routine.effectiveExecute && routine.triggerReturn)
        .map((routine) => routine.signature)),
    });
  });
}
