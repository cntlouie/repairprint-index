import { createHash } from "node:crypto";

import postgres from "postgres";

import {
  assessAnalyticsRoleMemberships,
  type AnalyticsRoleMembership,
} from "../src/domain/analytics-role-membership";
import {
  assessApprovedPgTrgmManifest,
  canonicalizePostgresExtensionManifest,
  PG_TRGM_EXPECTED_ROUTINE_COUNT,
  PG_TRGM_STAGING_BASELINE,
  type PostgresExtensionAclRow,
  type PostgresExtensionRoutineRow,
  type PostgresExtensionRow,
} from "../src/domain/postgres-extension-manifest";
import {
  assessSubmissionRoleMemberships,
  type SubmissionRoleMembership,
} from "../src/domain/submission-role-membership";
import { assessSourceRoleMemberships, type SourceRoleMembership } from "../src/domain/source-role-membership";

const publishedViews = [
  "published_brands",
  "published_designs",
  "published_fitments",
  "published_product_models",
] as const;
const catalogueViews = ["public_catalogue_fitments", "public_catalogue_unavailable_sources"] as const;
const privateContributionRelations = [
  "submissions",
  "submission_idempotency_bindings",
  "submission_intake_contacts",
  "submission_email_follow_ups",
  "submission_rate_limit_buckets",
  "submission_hmac_key_pin",
  "private_media_upload_sessions",
  "private_media_consents",
  "private_media_assets",
  "private_media_derivatives",
  "private_media_pending_objects",
  "private_media_redactions",
  "source_policy_reviews",
  "source_adapter_runs",
  "source_candidates",
  "source_candidate_versions",
  "source_candidate_acquisitions",
  "source_link_check_jobs",
  "source_link_checks",
  "private_analytics_daily_aggregates",
] as const;

// PostgreSQL 17 canonical catalogue fingerprints for the approved migration-0012
// definitions. Keep failures to a fixed code so live definitions are never logged.
const approvedAnalyticsConstraintExpressionSha256 =
  "9bd8ec343c13afc82ab42c808f1202d38267e648e2c034d1d4c6deb5548b9070";
const approvedAnalyticsRecorderDefinitionSha256 =
  "0a238707f868c64e51906f13acf3614733765aed7acdd746af1849ef3afbd081";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the staging foundation check.");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  let verifiedPgTrgmFingerprint: string | undefined;
  let verifiedPgTrgmRoutineCount: number | undefined;
  let auditTransactionOpen = false;

  try {
    // Keep extension attestation and every downstream role/privacy assertion in
    // one immutable snapshot so an extension change cannot cross the boundary
    // between fingerprinting and effective-privilege classification.
    await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    auditTransactionOpen = true;
    const [auditTransaction] = await sql<{
      isolation: string;
      readOnly: boolean;
      searchPath: string;
    }[]>`
      SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only')::boolean AS "readOnly",
        current_setting('search_path') AS "searchPath"
    `;
    if (!auditTransaction
      || auditTransaction.isolation !== "repeatable read"
      || !auditTransaction.readOnly) {
      throw new Error("PG_TRGM_STAGING_TRANSACTION_INVALID");
    }

    try {
      await sql.unsafe("SET LOCAL search_path = pg_catalog");

      const extensions = await sql<PostgresExtensionRow[]>`
        SELECT extension.extname AS name,
          extension.extversion AS version,
          namespace.nspname AS schema,
          owner_role.rolname AS owner,
          extension.extrelocatable AS relocatable,
          extension.extconfig::text[] AS configuration,
          extension.extcondition AS conditions
        FROM pg_catalog.pg_extension AS extension
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = extension.extnamespace
        INNER JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = extension.extowner
        WHERE extension.extname = 'pg_trgm'
      `;
      if (extensions.length !== 1 || !extensions[0]) {
        throw new Error(
          `PG_TRGM_STAGING_EXTENSION_COUNT_INVALID:${JSON.stringify({ actual: extensions.length })}`,
        );
      }

      const routines = await sql<PostgresExtensionRoutineRow[]>`
        SELECT namespace.nspname AS schema,
          pg_catalog.format(
            '%I.%I(%s)',
            namespace.nspname,
            procedure.proname,
            pg_catalog.pg_get_function_identity_arguments(procedure.oid)
          ) AS signature,
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
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
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

      const aclRows = await sql<PostgresExtensionAclRow[]>`
        SELECT pg_catalog.format(
            '%I.%I(%s)',
            namespace.nspname,
            procedure.proname,
            pg_catalog.pg_get_function_identity_arguments(procedure.oid)
          ) AS signature,
          pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
          CASE acl.grantee
            WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
          END AS grantee,
          acl.privilege_type AS privilege,
          acl.is_grantable AS grantable
        FROM pg_catalog.pg_proc AS procedure
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        INNER JOIN pg_catalog.pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.objid = procedure.oid
          AND dependency.objsubid = 0
          AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          AND dependency.refobjsubid = 0
          AND dependency.deptype = 'e'
        INNER JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS acl
        WHERE extension.extname = 'pg_trgm'
        ORDER BY signature, grantee, grantor, privilege, grantable
      `;

      const manifest = canonicalizePostgresExtensionManifest(extensions[0], routines, aclRows);
      const assessment = assessApprovedPgTrgmManifest(manifest);
      verifiedPgTrgmRoutineCount = assessment.routineCount;
      verifiedPgTrgmFingerprint = assessment.fingerprint;

      if (!assessment.valid
        || manifest.extension.owner !== PG_TRGM_STAGING_BASELINE.owner
        || verifiedPgTrgmRoutineCount !== PG_TRGM_EXPECTED_ROUTINE_COUNT
        || verifiedPgTrgmFingerprint !== PG_TRGM_STAGING_BASELINE.fingerprint) {
        throw new Error(
          `PG_TRGM_STAGING_BASELINE_INVALID:${JSON.stringify({
            violations: assessment.violations,
            identity: `${manifest.extension.name}@${manifest.extension.version}`
              + `:${manifest.extension.schema}:${manifest.extension.owner}`,
            expectedCount: PG_TRGM_EXPECTED_ROUTINE_COUNT,
            actualCount: verifiedPgTrgmRoutineCount,
            expectedFingerprint: PG_TRGM_STAGING_BASELINE.fingerprint,
            actualFingerprint: verifiedPgTrgmFingerprint,
          })}`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("PG_TRGM_STAGING_")) throw error;
      if (message.startsWith("POSTGRES_EXTENSION_MANIFEST_")) {
        throw new Error(`PG_TRGM_STAGING_MANIFEST_INVALID:${message}`);
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
      throw new Error(`PG_TRGM_STAGING_DATABASE_ERROR:${code}`);
    }
    await sql`SELECT pg_catalog.set_config('search_path', ${auditTransaction.searchPath}, true)`;

    const [tables] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    if (tables?.count !== 44) throw new Error(`Expected 44 public tables, found ${tables?.count}.`);
    const [enums] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND type.typtype = 'e'
    `;
    if (enums?.count !== 24) throw new Error(`Expected 24 public enums, found ${enums?.count}.`);

    const views = await sql<{ tableName: string }[]>`
      SELECT table_name AS "tableName"
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = ANY(${publishedViews})
      ORDER BY table_name
    `;
    const actualViews = views.map((row) => row.tableName);
    if (actualViews.join(",") !== [...publishedViews].sort().join(",")) {
      throw new Error(`Published view set is incomplete: ${actualViews.join(", ") || "none"}.`);
    }

    const triggers = await sql<{ triggerName: string }[]>`
      SELECT trigger.tgname AS "triggerName"
      FROM pg_trigger AS trigger
      INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'audit_log'
        AND trigger.tgname IN ('audit_log_immutable', 'audit_log_no_truncate')
        AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname
    `;
    if (triggers.length !== 2) throw new Error("Both audit_log immutability triggers are required.");

    const requiredAuditColumns = await sql<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'audit_log'
        AND column_name IN ('actor_id', 'reason', 'request_id')
        AND is_nullable = 'NO'
    `;
    if (requiredAuditColumns.length !== 3) {
      throw new Error("audit_log actor_id, reason, and request_id must all be required.");
    }

    const [leakedFitments] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM published_fitments
      WHERE publication_status <> 'published'
    `;
    if (leakedFitments?.count !== 0) throw new Error("published_fitments exposed a non-published row.");

    const [baseTableGrants] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.table_privileges AS grant_row
      INNER JOIN information_schema.tables AS relation
        ON relation.table_schema = grant_row.table_schema
       AND relation.table_name = grant_row.table_name
       AND relation.table_type = 'BASE TABLE'
      WHERE grant_row.table_schema = 'public'
        AND grant_row.grantee IN ('anon', 'authenticated')
    `;
    if (baseTableGrants?.count !== 0) {
      throw new Error("anon or authenticated still has a direct grant on a public base table.");
    }

    const [publishedViewGrants] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name = ANY(${publishedViews})
        AND grantee IN ('anon', 'authenticated')
        AND privilege_type = 'SELECT'
    `;
    if (publishedViewGrants?.count !== 0) {
      throw new Error("anon or authenticated can bypass WP-07 eligibility through a legacy broad-row view.");
    }

    const [catalogueViewGrants] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name = ANY(${catalogueViews})
        AND grantee IN ('anon', 'authenticated')
        AND privilege_type = 'SELECT'
    `;
    if (catalogueViewGrants?.count !== catalogueViews.length * 2) {
      throw new Error("anon and authenticated must have SELECT on both publication-filtered catalogue views.");
    }

    const [schemaUsage] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM (VALUES ('anon'), ('authenticated')) AS required_role(role_name)
      WHERE has_schema_privilege(required_role.role_name, 'public', 'USAGE')
    `;
    if (schemaUsage?.count !== 2) throw new Error("anon and authenticated require public-schema usage for published views.");

    const [unsafeCatalogueColumns] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('public_catalogue_fitments', 'public_catalogue_unavailable_sources')
        AND column_name IN (
          'payload', 'email', 'contact_email', 'contributor_key', 'idempotency_actor_key', 'idempotency_key_hash',
          'request_fingerprint', 'content_fingerprint', 'challenge_provider', 'challenge_verified_at',
          'notes', 'moderation_status', 'supporting_excerpt', 'source_citation_id', 'source_url'
        )
        AND NOT (table_name = 'public_catalogue_fitments' AND column_name = 'source_url')
    `;
    if (unsafeCatalogueColumns?.count !== 0) {
      throw new Error("A catalogue or tombstone view exposes a private or unsafe column.");
    }

    const [catalogueDemoLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_catalogue_fitments
      WHERE source_id IN (SELECT id FROM sources WHERE source_type = 'demo')
    `;
    if (catalogueDemoLeak?.count !== 0) throw new Error("Demo sources leaked into the production catalogue view.");

    const [searchViewGrants] = await sql<{ anonCanRead: boolean; authenticatedCanRead: boolean }[]>`
      SELECT
        has_table_privilege('anon', 'public.public_search_documents', 'SELECT') AS "anonCanRead",
        has_table_privilege('authenticated', 'public.public_search_documents', 'SELECT') AS "authenticatedCanRead"
    `;
    if (!searchViewGrants?.anonCanRead || !searchViewGrants.authenticatedCanRead) {
      throw new Error("anon and authenticated must have SELECT on the publication-filtered search view.");
    }

    const [privateContributionBoundary] = await sql<{
      analyticsRecorderPrivileges: number;
      cleanupPrivileges: number;
      relationPrivileges: number;
    }[]>`
      SELECT
        (SELECT count(*)::int
          FROM (VALUES ('anon'), ('authenticated')) AS required_role(role_name)
          WHERE has_function_privilege(
            required_role.role_name,
            'public.record_private_analytics_event(text,jsonb)',
            'EXECUTE'
          )) AS "analyticsRecorderPrivileges",
        (SELECT count(*)::int
          FROM (VALUES ('anon'), ('authenticated')) AS required_role(role_name)
          WHERE has_function_privilege(
            required_role.role_name,
            'public.cleanup_expired_submission_intakes(integer)',
            'EXECUTE'
          )) AS "cleanupPrivileges",
        (SELECT count(*)::int
          FROM (VALUES ('anon'), ('authenticated')) AS required_role(role_name)
          CROSS JOIN unnest(${privateContributionRelations}::text[]) AS private_relation(relation_name)
          WHERE has_table_privilege(
            required_role.role_name,
            format('public.%I', private_relation.relation_name),
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )) AS "relationPrivileges"
    `;
    if (
      privateContributionBoundary?.relationPrivileges !== 0
      || privateContributionBoundary.cleanupPrivileges !== 0
      || privateContributionBoundary.analyticsRecorderPrivileges !== 0
    ) {
      throw new Error(
        `Anonymous roles can bypass the server-only contribution boundary: ${JSON.stringify(privateContributionBoundary)}.`,
      );
    }

    const submissionRoleMemberships = await sql<SubmissionRoleMembership[]>`
      SELECT
        granted_role.rolname AS "grantedRole",
        member_role.rolname AS "memberRole",
        grantor_role.rolname AS "grantorRole",
        membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption",
        membership.set_option AS "setOption"
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
         OR member_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    `;
    const submissionRoleMembershipAssessment = assessSubmissionRoleMemberships(submissionRoleMemberships);
    if (!submissionRoleMembershipAssessment.valid) {
      throw new Error(
        `Submission role membership boundary is invalid: ${JSON.stringify(submissionRoleMembershipAssessment)}.`,
      );
    }

    const sourceRoleMemberships = await sql<SourceRoleMembership[]>`
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
    const sourceRoleAssessment = assessSourceRoleMemberships(sourceRoleMemberships);
    if (!sourceRoleAssessment.valid) {
      throw new Error(`Source role membership boundary is invalid: ${JSON.stringify(sourceRoleAssessment)}.`);
    }

    const analyticsRoleMemberships = await sql<AnalyticsRoleMembership[]>`
      SELECT granted_role.rolname AS "grantedRole", member_role.rolname AS "memberRole",
        grantor_role.rolname AS "grantorRole", membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption", membership.set_option AS "setOption"
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
         OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    `;
    const analyticsRoleAssessment = assessAnalyticsRoleMemberships(analyticsRoleMemberships);
    if (!analyticsRoleAssessment.valid || analyticsRoleMemberships.length !== 2) {
      throw new Error(
        `Analytics role membership boundary is invalid: ${JSON.stringify({
          expectedCount: 2,
          actualCount: analyticsRoleMemberships.length,
          assessment: analyticsRoleAssessment,
        })}.`,
      );
    }

    const [analyticsDefinitionProof] = await sql<{
      constraintCount: number;
      constraintExpression: string | null;
      constraintValidated: boolean | null;
      recorderDefinition: string | null;
    }[]>`
      SELECT
        (SELECT count(*)::int
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('public.private_analytics_daily_aggregates')
            AND constraint_row.conname = 'private_analytics_dimensions_ck'
            AND constraint_row.contype = 'c') AS "constraintCount",
        (SELECT constraint_row.convalidated
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('public.private_analytics_daily_aggregates')
            AND constraint_row.conname = 'private_analytics_dimensions_ck'
            AND constraint_row.contype = 'c') AS "constraintValidated",
        (SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('public.private_analytics_daily_aggregates')
            AND constraint_row.conname = 'private_analytics_dimensions_ck'
            AND constraint_row.contype = 'c') AS "constraintExpression",
        pg_get_functiondef(
          to_regprocedure('public.record_private_analytics_event(text,jsonb)')
        ) AS "recorderDefinition"
    `;
    if (!analyticsDefinitionProof
      || analyticsDefinitionProof.constraintCount !== 1
      || analyticsDefinitionProof.constraintValidated !== true
      || analyticsDefinitionProof.constraintExpression === null
      || sha256(analyticsDefinitionProof.constraintExpression)
        !== approvedAnalyticsConstraintExpressionSha256
      || analyticsDefinitionProof.recorderDefinition === null
      || sha256(analyticsDefinitionProof.recorderDefinition)
        !== approvedAnalyticsRecorderDefinitionSha256) {
      throw new Error("ANALYTICS_LIVE_DEFINITION_FINGERPRINT_INVALID");
    }

    const [analyticsBoundary] = await sql<{
      aggregateRows: number;
      anonymousBoundaryViolations: string[];
      constraintViolations: string[];
      invalidTableShape: number;
      maintenanceColumnPrivilegeDelta: string[];
      maintenanceDirectColumnAcls: string[];
      maintenanceRelationAclDelta: string[];
      maintenanceRelationPrivilegeDelta: string[];
      maintenanceSequencePrivileges: string[];
      missingRecorderExecuteRoles: string[];
      missingRoles: string[];
      nonCallableRoutineDelta: string[];
      recorderDefinitionViolations: string[];
      roleAttributeViolations: string[];
      schemaPrivilegeViolations: string[];
      serviceColumnPrivileges: string[];
      serviceRelationPrivileges: string[];
      serviceRoutineAclDelta: string[];
      serviceSequencePrivileges: string[];
      unexpectedMaintenanceRoutines: string[];
      unexpectedOwnerships: string[];
      unexpectedServiceRoutines: string[];
    }[]>`
      WITH expected_analytics_roles(role_name) AS (
        VALUES ('repairprint_analytics_service'), ('repairprint_analytics_maintenance')
      ), analytics_roles AS (
        SELECT expected.role_name, role.oid AS role_oid
        FROM expected_analytics_roles AS expected
        LEFT JOIN pg_roles AS role ON role.rolname = expected.role_name
      ), anonymous_roles(role_name, role_oid) AS (
        SELECT expected.role_name, role.oid
        FROM (VALUES ('anon'), ('authenticated')) AS expected(role_name)
        LEFT JOIN pg_roles AS role ON role.rolname = expected.role_name
      ), relation_privilege_types(privilege_type) AS (
        VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
          ('TRIGGER'), ('MAINTAIN')
      ), column_privilege_types(privilege_type) AS (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
      ), sequence_privilege_types(privilege_type) AS (
        VALUES ('SELECT'), ('UPDATE'), ('USAGE')
      ), public_relations AS (
        SELECT relation.oid, format('%I.%I', namespace.nspname, relation.relname) AS relation_identity
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ), expected_relation_privileges(role_name, relation_identity, privilege_type) AS (
        VALUES
          ('repairprint_analytics_maintenance', 'public.private_analytics_daily_aggregates', 'SELECT'),
          ('repairprint_analytics_maintenance', 'public.private_analytics_daily_aggregates', 'INSERT'),
          ('repairprint_analytics_maintenance', 'public.private_analytics_daily_aggregates', 'UPDATE'),
          ('repairprint_analytics_maintenance', 'public.public_catalogue_fitments', 'SELECT')
      ), expected_maintenance_relation_acl(
        relation_identity, grantee_role, grantor_role, privilege_type, is_grantable
      ) AS (
        VALUES
          ('public.private_analytics_daily_aggregates',
            'repairprint_analytics_maintenance', 'postgres', 'SELECT', false),
          ('public.private_analytics_daily_aggregates',
            'repairprint_analytics_maintenance', 'postgres', 'INSERT', false),
          ('public.private_analytics_daily_aggregates',
            'repairprint_analytics_maintenance', 'postgres', 'UPDATE', false),
          ('public.public_catalogue_fitments',
            'repairprint_analytics_maintenance', 'postgres', 'SELECT', false)
      ), actual_maintenance_relation_acl AS (
        SELECT format('%I.%I', namespace.nspname, relation.relname) AS relation_identity,
          grantee_role.rolname::text AS grantee_role,
          COALESCE(grantor_role.rolname::text, 'unknown') AS grantor_role,
          acl.privilege_type,
          acl.is_grantable
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
        INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = acl.grantee
        LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = acl.grantor
        WHERE grantee_role.rolname = 'repairprint_analytics_maintenance'
      ), maintenance_relation_acl_delta AS (
        SELECT 'missing:' || missing.relation_identity || ':' || missing.privilege_type
          || ':grantee=' || missing.grantee_role || ':grantor=' || missing.grantor_role
          || ':grantable=' || missing.is_grantable::text AS identity
        FROM (
          SELECT * FROM expected_maintenance_relation_acl
          EXCEPT
          SELECT * FROM actual_maintenance_relation_acl
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.relation_identity || ':' || extra.privilege_type
          || ':grantee=' || extra.grantee_role || ':grantor=' || extra.grantor_role
          || ':grantable=' || extra.is_grantable::text
        FROM (
          SELECT * FROM actual_maintenance_relation_acl
          EXCEPT
          SELECT * FROM expected_maintenance_relation_acl
        ) AS extra
      ), maintenance_direct_column_acl AS (
        SELECT format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname)
          || ':' || acl.privilege_type
          || ':grantee=' || grantee_role.rolname
          || ':grantor=' || COALESCE(grantor_role.rolname, 'unknown')
          || ':grantable=' || acl.is_grantable::text AS identity
        FROM pg_attribute AS attribute
        INNER JOIN pg_class AS relation ON relation.oid = attribute.attrelid
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
        INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = acl.grantee
        LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = acl.grantor
        WHERE attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND grantee_role.rolname = 'repairprint_analytics_maintenance'
      ), actual_relation_privileges AS (
        SELECT role.role_name, relation.relation_identity, privilege.privilege_type
        FROM analytics_roles AS role
        CROSS JOIN public_relations AS relation
        CROSS JOIN relation_privilege_types AS privilege
        WHERE role.role_oid IS NOT NULL
          AND has_table_privilege(role.role_oid, relation.oid, privilege.privilege_type)
      ), maintenance_relation_delta AS (
        SELECT 'missing:' || missing.relation_identity || ':' || missing.privilege_type AS identity
        FROM (
          SELECT relation_identity, privilege_type FROM expected_relation_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
          EXCEPT
          SELECT relation_identity, privilege_type FROM actual_relation_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.relation_identity || ':' || extra.privilege_type
        FROM (
          SELECT relation_identity, privilege_type FROM actual_relation_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
          EXCEPT
          SELECT relation_identity, privilege_type FROM expected_relation_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
        ) AS extra
      ), public_columns AS (
        SELECT relation.oid AS relation_oid, relation.relation_identity, attribute.attnum,
          attribute.attname AS column_name
        FROM public_relations AS relation
        INNER JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
        WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      ), expected_column_privileges AS (
        SELECT expected.role_name, expected.relation_identity, column_row.column_name,
          expected.privilege_type
        FROM expected_relation_privileges AS expected
        INNER JOIN public_columns AS column_row
          ON column_row.relation_identity = expected.relation_identity
        WHERE expected.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
      ), actual_column_privileges AS (
        SELECT role.role_name, column_row.relation_identity, column_row.column_name,
          privilege.privilege_type
        FROM analytics_roles AS role
        CROSS JOIN public_columns AS column_row
        CROSS JOIN column_privilege_types AS privilege
        WHERE role.role_oid IS NOT NULL
          AND has_column_privilege(
            role.role_oid,
            column_row.relation_oid,
            column_row.attnum,
            privilege.privilege_type
          )
      ), maintenance_column_delta AS (
        SELECT 'missing:' || missing.relation_identity || '.' || missing.column_name
          || ':' || missing.privilege_type AS identity
        FROM (
          SELECT relation_identity, column_name, privilege_type FROM expected_column_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
          EXCEPT
          SELECT relation_identity, column_name, privilege_type FROM actual_column_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.relation_identity || '.' || extra.column_name
          || ':' || extra.privilege_type
        FROM (
          SELECT relation_identity, column_name, privilege_type FROM actual_column_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
          EXCEPT
          SELECT relation_identity, column_name, privilege_type FROM expected_column_privileges
          WHERE role_name = 'repairprint_analytics_maintenance'
        ) AS extra
      ), public_sequences AS (
        SELECT sequence.oid, format('%I.%I', namespace.nspname, sequence.relname) AS sequence_identity
        FROM pg_class AS sequence
        INNER JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
        WHERE namespace.nspname = 'public' AND sequence.relkind = 'S'
      ), actual_sequence_privileges AS (
        SELECT role.role_name, sequence.sequence_identity, privilege.privilege_type
        FROM analytics_roles AS role
        CROSS JOIN public_sequences AS sequence
        CROSS JOIN sequence_privilege_types AS privilege
        WHERE role.role_oid IS NOT NULL
          AND has_sequence_privilege(role.role_oid, sequence.oid, privilege.privilege_type)
      ), recorder_named AS (
        SELECT procedure.*
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname = 'record_private_analytics_event'
      ), recorder AS (
        SELECT procedure.*
        FROM pg_proc AS procedure
        WHERE procedure.oid = to_regprocedure('public.record_private_analytics_event(text,jsonb)')
      ), approved_pg_trgm_routines AS (
        -- Only exact pg_trgm extension dependencies receive the approved PUBLIC-EXECUTE
        -- baseline exception. Trigger return types remain a separate non-callable class.
        SELECT procedure.oid
        FROM pg_proc AS procedure
        INNER JOIN pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND dependency.objid = procedure.oid
          AND dependency.objsubid = 0
          AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
          AND dependency.refobjsubid = 0
          AND dependency.deptype = 'e'
        INNER JOIN pg_extension AS extension ON extension.oid = dependency.refobjid
        WHERE extension.extname = 'pg_trgm'
      ), public_routines AS (
        SELECT procedure.oid,
          format(
            '%I.%I(%s)',
            namespace.nspname,
            procedure.proname,
            pg_catalog.oidvectortypes(procedure.proargtypes)
          ) AS routine_identity,
          procedure.oid IN (SELECT oid FROM approved_pg_trgm_routines)
            AS approved_pg_trgm_member,
          procedure.prorettype IN (
            'pg_catalog.trigger'::regtype::oid,
            'pg_catalog.event_trigger'::regtype::oid
          ) AS not_directly_callable
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
      ), effective_callable_routines AS (
        SELECT role.role_name, routine.routine_identity
        FROM analytics_roles AS role
        CROSS JOIN public_routines AS routine
        WHERE role.role_oid IS NOT NULL
          AND NOT routine.not_directly_callable
          AND NOT routine.approved_pg_trgm_member
          AND has_function_privilege(role.role_oid, routine.oid, 'EXECUTE')
      ), expected_non_callable_routines(role_name, routine_identity) AS (
        VALUES
          ('repairprint_analytics_service', 'public.reject_audit_log_mutation()'),
          ('repairprint_analytics_maintenance', 'public.reject_audit_log_mutation()')
      ), actual_non_callable_routines AS (
        SELECT role.role_name, routine.routine_identity
        FROM analytics_roles AS role
        CROSS JOIN public_routines AS routine
        WHERE role.role_oid IS NOT NULL
          AND routine.not_directly_callable
          AND has_function_privilege(role.role_oid, routine.oid, 'EXECUTE')
      ), non_callable_routine_delta AS (
        SELECT 'missing:' || missing.role_name || ':' || missing.routine_identity AS identity
        FROM (
          SELECT * FROM expected_non_callable_routines
          EXCEPT
          SELECT * FROM actual_non_callable_routines
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.role_name || ':' || extra.routine_identity
        FROM (
          SELECT * FROM actual_non_callable_routines
          EXCEPT
          SELECT * FROM expected_non_callable_routines
        ) AS extra
      ), expected_service_routine_acl(
        routine_identity, grantor_role, privilege_type, is_grantable
      ) AS (
        VALUES (
          'public.record_private_analytics_event(text, jsonb)',
          'repairprint_analytics_maintenance',
          'EXECUTE',
          false
        )
      ), actual_service_routine_acl AS (
        SELECT format(
            '%I.%I(%s)',
            namespace.nspname,
            procedure.proname,
            pg_catalog.oidvectortypes(procedure.proargtypes)
          ) AS routine_identity,
          grantor_role.rolname AS grantor_role,
          acl.privilege_type,
          acl.is_grantable
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
        INNER JOIN analytics_roles AS service_role
          ON service_role.role_name = 'repairprint_analytics_service'
          AND service_role.role_oid = acl.grantee
        LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = acl.grantor
      ), service_routine_acl_delta AS (
        SELECT 'missing:' || missing.routine_identity || ':' || missing.privilege_type
          || ':grantor=' || missing.grantor_role || ':grantable=' || missing.is_grantable::text AS identity
        FROM (
          SELECT * FROM expected_service_routine_acl
          EXCEPT
          SELECT * FROM actual_service_routine_acl
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.routine_identity || ':' || extra.privilege_type
          || ':grantor=' || COALESCE(extra.grantor_role, 'unknown')
          || ':grantable=' || extra.is_grantable::text
        FROM (
          SELECT * FROM actual_service_routine_acl
          EXCEPT
          SELECT * FROM expected_service_routine_acl
        ) AS extra
      ), expected_owned_objects(role_name, object_kind, object_identity) AS (
        VALUES (
          'repairprint_analytics_maintenance',
          'routine',
          'public.record_private_analytics_event(text, jsonb)'
        )
      ), actual_owned_objects AS (
        SELECT owner.rolname AS role_name, 'relation'::text AS object_kind,
          format('%I.%I', namespace.nspname, relation.relname) AS object_identity
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        INNER JOIN pg_roles AS owner ON owner.oid = relation.relowner
        WHERE owner.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
        UNION ALL
        SELECT owner.rolname, 'routine', format(
            '%I.%I(%s)',
            namespace.nspname,
            procedure.proname,
            pg_catalog.oidvectortypes(procedure.proargtypes)
          )
        FROM pg_proc AS procedure
        INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        INNER JOIN pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE owner.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
        UNION ALL
        SELECT owner.rolname, 'schema', format('%I', namespace.nspname)
        FROM pg_namespace AS namespace
        INNER JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE owner.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
        UNION ALL
        SELECT owner.rolname, 'type', format('%I.%I', namespace.nspname, type.typname)
        FROM pg_type AS type
        INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
        INNER JOIN pg_roles AS owner ON owner.oid = type.typowner
        WHERE owner.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      ), ownership_delta AS (
        SELECT 'missing:' || missing.role_name || ':' || missing.object_kind
          || ':' || missing.object_identity AS identity
        FROM (
          SELECT * FROM expected_owned_objects
          EXCEPT
          SELECT * FROM actual_owned_objects
        ) AS missing
        UNION ALL
        SELECT 'unexpected:' || extra.role_name || ':' || extra.object_kind
          || ':' || extra.object_identity
        FROM (
          SELECT * FROM actual_owned_objects
          EXCEPT
          SELECT * FROM expected_owned_objects
        ) AS extra
      ), ownership_dependency_violation AS (
        SELECT 'unexpected:' || role.role_name || ':' || CASE
          WHEN dependency.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
          THEN pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid)
          ELSE 'database=' || dependency.dbid::text || ':class=' || dependency.classid::text
            || ':object=' || dependency.objid::text || ':subobject=' || dependency.objsubid::text
        END AS identity
        FROM analytics_roles AS role
        INNER JOIN pg_shdepend AS dependency
          ON dependency.refclassid = 'pg_catalog.pg_authid'::regclass
          AND dependency.refobjid = role.role_oid
          AND dependency.deptype = 'o'
        WHERE NOT (
          role.role_name = 'repairprint_analytics_maintenance'
          AND dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND dependency.objid = to_regprocedure(
            'public.record_private_analytics_event(text,jsonb)'
          )::oid
        )
        UNION ALL
        SELECT 'missing:repairprint_analytics_maintenance:routine:'
          || 'public.record_private_analytics_event(text, jsonb)'
        WHERE NOT EXISTS (
          SELECT 1
          FROM analytics_roles AS role
          INNER JOIN pg_shdepend AS dependency
            ON dependency.refclassid = 'pg_catalog.pg_authid'::regclass
            AND dependency.refobjid = role.role_oid
            AND dependency.deptype = 'o'
          WHERE role.role_name = 'repairprint_analytics_maintenance'
            AND dependency.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND dependency.classid = 'pg_catalog.pg_proc'::regclass
            AND dependency.objid = to_regprocedure(
              'public.record_private_analytics_event(text,jsonb)'
            )::oid
        )
      ), aggregate_relation AS (
        SELECT relation.*
        FROM pg_class AS relation
        WHERE relation.oid = to_regclass('public.private_analytics_daily_aggregates')
      ), anonymous_boundary_violation AS (
        SELECT 'PUBLIC:routine:public.record_private_analytics_event(text, jsonb):EXECUTE' AS identity
        FROM recorder
        CROSS JOIN LATERAL aclexplode(COALESCE(recorder.proacl, acldefault('f', recorder.proowner))) AS acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        UNION ALL
        SELECT role.role_name || ':routine:public.record_private_analytics_event(text, jsonb):EXECUTE'
        FROM anonymous_roles AS role
        CROSS JOIN recorder
        WHERE role.role_oid IS NOT NULL
          AND has_function_privilege(role.role_oid, recorder.oid, 'EXECUTE')
        UNION ALL
        SELECT 'PUBLIC:relation:public.private_analytics_daily_aggregates:' || acl.privilege_type
        FROM aggregate_relation AS relation
        CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS acl
        WHERE acl.grantee = 0
        UNION ALL
        SELECT role.role_name || ':relation:public.private_analytics_daily_aggregates:'
          || privilege.privilege_type
        FROM anonymous_roles AS role
        CROSS JOIN aggregate_relation AS relation
        CROSS JOIN relation_privilege_types AS privilege
        WHERE role.role_oid IS NOT NULL
          AND has_table_privilege(role.role_oid, relation.oid, privilege.privilege_type)
        UNION ALL
        SELECT 'PUBLIC:column:public.private_analytics_daily_aggregates.' || attribute.attname
          || ':' || acl.privilege_type
        FROM aggregate_relation AS relation
        INNER JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
        WHERE attribute.attnum > 0 AND NOT attribute.attisdropped AND acl.grantee = 0
        UNION ALL
        SELECT role.role_name || ':column:public.private_analytics_daily_aggregates.'
          || attribute.attname || ':' || privilege.privilege_type
        FROM anonymous_roles AS role
        CROSS JOIN aggregate_relation AS relation
        INNER JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
        CROSS JOIN column_privilege_types AS privilege
        WHERE role.role_oid IS NOT NULL AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND has_column_privilege(
            role.role_oid,
            relation.oid,
            attribute.attnum,
            privilege.privilege_type
          )
      ), dimension_constraint AS (
        SELECT constraint_row.convalidated
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = to_regclass('public.private_analytics_daily_aggregates')
          AND constraint_row.conname = 'private_analytics_dimensions_ck'
          AND constraint_row.contype = 'c'
      ), constraint_violation AS (
        SELECT 'private_analytics_dimensions_ck:missing-or-duplicate' AS identity
        WHERE (SELECT count(*) FROM dimension_constraint) <> 1
        UNION ALL
        SELECT 'private_analytics_dimensions_ck:not-validated'
        FROM dimension_constraint WHERE NOT convalidated
      ), recorder_definition_violation AS (
        SELECT 'record_private_analytics_event:missing-or-overloaded' AS identity
        WHERE (SELECT count(*) FROM recorder_named) <> 1 OR (SELECT count(*) FROM recorder) <> 1
        UNION ALL
        SELECT 'record_private_analytics_event:definition'
        FROM recorder AS procedure
        INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
        INNER JOIN pg_language AS language ON language.oid = procedure.prolang
        WHERE owner_role.rolname <> 'repairprint_analytics_maintenance'
          OR NOT procedure.prosecdef
          OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
          OR procedure.prokind <> 'f'
          OR procedure.prorettype <> 'pg_catalog.void'::regtype::oid
          OR language.lanname <> 'plpgsql'
      ), schema_privilege_violation AS (
        SELECT role.role_name || ':public:USAGE:missing' AS identity
        FROM analytics_roles AS role
        WHERE role.role_oid IS NULL
          OR NOT has_schema_privilege(role.role_oid, 'public', 'USAGE')
        UNION ALL
        SELECT role.role_name || ':' || namespace.nspname || ':CREATE:unexpected'
        FROM analytics_roles AS role
        CROSS JOIN pg_namespace AS namespace
        WHERE role.role_oid IS NOT NULL
          AND namespace.nspname !~ '^pg_temp_[0-9]+$'
          AND namespace.nspname !~ '^pg_toast_temp_[0-9]+$'
          AND has_schema_privilege(role.role_oid, namespace.oid, 'CREATE')
      )
      SELECT
        (SELECT COALESCE(array_agg(role_name ORDER BY role_name), ARRAY[]::text[])
          FROM analytics_roles WHERE role_oid IS NULL) AS "missingRoles",
        (SELECT COALESCE(array_agg(role.rolname ORDER BY role.rolname), ARRAY[]::text[])
          FROM pg_roles AS role
          WHERE (role.rolname = 'repairprint_analytics_service' AND (
              NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))
            OR (role.rolname = 'repairprint_analytics_maintenance' AND (
              role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))) AS "roleAttributeViolations",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM service_routine_acl_delta) AS "serviceRoutineAclDelta",
        (SELECT COALESCE(array_agg(role_name ORDER BY role_name), ARRAY[]::text[])
          FROM analytics_roles AS role
          WHERE role.role_oid IS NULL OR NOT EXISTS (
            SELECT 1 FROM recorder
            WHERE has_function_privilege(role.role_oid, recorder.oid, 'EXECUTE')
          )) AS "missingRecorderExecuteRoles",
        (SELECT COALESCE(array_agg(routine_identity ORDER BY routine_identity), ARRAY[]::text[])
          FROM effective_callable_routines
          WHERE role_name = 'repairprint_analytics_service'
            AND routine_identity <> 'public.record_private_analytics_event(text, jsonb)') AS "unexpectedServiceRoutines",
        (SELECT COALESCE(array_agg(routine_identity ORDER BY routine_identity), ARRAY[]::text[])
          FROM effective_callable_routines
          WHERE role_name = 'repairprint_analytics_maintenance'
            AND routine_identity <> 'public.record_private_analytics_event(text, jsonb)') AS "unexpectedMaintenanceRoutines",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM non_callable_routine_delta) AS "nonCallableRoutineDelta",
        (SELECT COALESCE(array_agg(relation_identity || ':' || privilege_type
            ORDER BY relation_identity, privilege_type), ARRAY[]::text[])
          FROM actual_relation_privileges
          WHERE role_name = 'repairprint_analytics_service') AS "serviceRelationPrivileges",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM maintenance_relation_delta) AS "maintenanceRelationPrivilegeDelta",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM maintenance_relation_acl_delta) AS "maintenanceRelationAclDelta",
        (SELECT COALESCE(array_agg(relation_identity || '.' || column_name || ':' || privilege_type
            ORDER BY relation_identity, column_name, privilege_type), ARRAY[]::text[])
          FROM actual_column_privileges
          WHERE role_name = 'repairprint_analytics_service') AS "serviceColumnPrivileges",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM maintenance_column_delta) AS "maintenanceColumnPrivilegeDelta",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM maintenance_direct_column_acl) AS "maintenanceDirectColumnAcls",
        (SELECT COALESCE(array_agg(sequence_identity || ':' || privilege_type
            ORDER BY sequence_identity, privilege_type), ARRAY[]::text[])
          FROM actual_sequence_privileges
          WHERE role_name = 'repairprint_analytics_service') AS "serviceSequencePrivileges",
        (SELECT COALESCE(array_agg(sequence_identity || ':' || privilege_type
            ORDER BY sequence_identity, privilege_type), ARRAY[]::text[])
          FROM actual_sequence_privileges
          WHERE role_name = 'repairprint_analytics_maintenance') AS "maintenanceSequencePrivileges",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM (
            SELECT identity FROM ownership_delta
            UNION
            SELECT identity FROM ownership_dependency_violation
          ) AS ownership_violation) AS "unexpectedOwnerships",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM schema_privilege_violation) AS "schemaPrivilegeViolations",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM anonymous_boundary_violation) AS "anonymousBoundaryViolations",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM constraint_violation) AS "constraintViolations",
        (SELECT COALESCE(array_agg(identity ORDER BY identity), ARRAY[]::text[])
          FROM recorder_definition_violation) AS "recorderDefinitionViolations",
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'private_analytics_daily_aggregates'
            AND column_name NOT IN ('event_day', 'event_name', 'dimensions', 'event_count'))
          + CASE WHEN (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'private_analytics_daily_aggregates') = 4
            THEN 0 ELSE 1 END AS "invalidTableShape",
        (SELECT count(*)::int FROM public.private_analytics_daily_aggregates) AS "aggregateRows"
    `;
    if (!analyticsBoundary
      || analyticsBoundary.missingRoles.length !== 0
      || analyticsBoundary.roleAttributeViolations.length !== 0
      || analyticsBoundary.serviceRoutineAclDelta.length !== 0
      || analyticsBoundary.missingRecorderExecuteRoles.length !== 0
      || analyticsBoundary.unexpectedServiceRoutines.length !== 0
      || analyticsBoundary.unexpectedMaintenanceRoutines.length !== 0
      || analyticsBoundary.nonCallableRoutineDelta.length !== 0
      || analyticsBoundary.serviceRelationPrivileges.length !== 0
      || analyticsBoundary.maintenanceRelationPrivilegeDelta.length !== 0
      || analyticsBoundary.maintenanceRelationAclDelta.length !== 0
      || analyticsBoundary.serviceColumnPrivileges.length !== 0
      || analyticsBoundary.maintenanceColumnPrivilegeDelta.length !== 0
      || analyticsBoundary.maintenanceDirectColumnAcls.length !== 0
      || analyticsBoundary.serviceSequencePrivileges.length !== 0
      || analyticsBoundary.maintenanceSequencePrivileges.length !== 0
      || analyticsBoundary.unexpectedOwnerships.length !== 0
      || analyticsBoundary.schemaPrivilegeViolations.length !== 0
      || analyticsBoundary.anonymousBoundaryViolations.length !== 0
      || analyticsBoundary.constraintViolations.length !== 0
      || analyticsBoundary.recorderDefinitionViolations.length !== 0
      || analyticsBoundary.invalidTableShape !== 0
      || analyticsBoundary.aggregateRows !== 0) {
      throw new Error(`Analytics role/privacy boundary is invalid: ${JSON.stringify(analyticsBoundary)}.`);
    }

    const [sourceBoundary] = await sql<{
      anonEffectiveExecute: number;
      anonExplicitExecute: number;
      authenticatedEffectiveExecute: number;
      authenticatedExplicitExecute: number;
      extraServiceFunctionGrants: number;
      invalidFunctionDefinitions: number;
      maintenanceFunctionOwnerships: number;
      missingFunctions: number;
      publicAclExecute: number;
      publicExplicitExecute: number;
      publicGrantors: string[];
      serviceCanCreateSchema: boolean;
      serviceFunctionPrivileges: number;
      serviceSequencePrivileges: number;
      serviceTablePrivileges: number;
      unexpectedOverloads: number;
      unsafeAttributes: number;
    }[]>`
      WITH expected(signature, name) AS (
        VALUES
          ('public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)', 'upsert_private_source_candidate'),
          ('public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)', 'transition_source_candidate_version'),
          ('public.claim_source_link_check_jobs(text,integer,integer)', 'claim_source_link_check_jobs'),
          ('public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)', 'complete_source_link_check')
      ), resolved AS (
        SELECT signature, name, to_regprocedure(signature) AS oid FROM expected
      )
      SELECT
        (SELECT count(*)::int FROM pg_roles AS role
          WHERE (role.rolname = 'repairprint_source_service' AND (
              NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))
            OR (role.rolname = 'repairprint_source_maintenance' AND (
              role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))) AS "unsafeAttributes",
        (SELECT count(*)::int FROM resolved WHERE oid IS NULL) AS "missingFunctions",
        (SELECT count(*)::int FROM pg_proc AS procedure
          INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public' AND procedure.proname IN (SELECT name FROM expected)
            AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.oid::oid = procedure.oid)) AS "unexpectedOverloads",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
          WHERE owner_role.rolname <> 'repairprint_source_maintenance' OR NOT procedure.prosecdef
             OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]) AS "invalidFunctionDefinitions",
        (SELECT count(*)::int FROM resolved WHERE oid IS NOT NULL
          AND has_function_privilege('repairprint_source_service', oid::oid, 'EXECUTE')) AS "serviceFunctionPrivileges",
        (SELECT count(*)::int FROM pg_proc AS procedure
          INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
          WHERE namespace.nspname = 'public' AND acl.grantee = (
            SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service')
            AND acl.privilege_type = 'EXECUTE'
            AND NOT EXISTS (SELECT 1 FROM resolved WHERE resolved.oid::oid = procedure.oid)) AS "extraServiceFunctionGrants",
        (SELECT count(*)::int FROM pg_class AS relation
          INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege('repairprint_source_service', relation.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS "serviceTablePrivileges",
        (SELECT count(*)::int FROM pg_class AS sequence
          INNER JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
          CROSS JOIN LATERAL aclexplode(sequence.relacl) AS acl
          WHERE namespace.nspname = 'public' AND sequence.relkind = 'S'
            AND acl.grantee = (
              SELECT oid FROM pg_roles WHERE rolname = 'repairprint_source_service')) AS "serviceSequencePrivileges",
        has_schema_privilege('repairprint_source_service', 'public', 'CREATE') AS "serviceCanCreateSchema",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
          WHERE namespace.nspname = 'public' AND owner_role.rolname = 'repairprint_source_maintenance'
            AND procedure.prosecdef
            AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]) AS "maintenanceFunctionOwnerships",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicAclExecute",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicExplicitExecute",
        (SELECT COALESCE(array_agg(DISTINCT grantor.rolname ORDER BY grantor.rolname), ARRAY[]::text[])
          FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
          INNER JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicGrantors",
        (SELECT count(*)::int FROM resolved WHERE oid IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
          AND has_function_privilege('anon', oid::oid, 'EXECUTE')) AS "anonEffectiveExecute",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
            AND acl.privilege_type = 'EXECUTE') AS "anonExplicitExecute",
        (SELECT count(*)::int FROM resolved WHERE oid IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
          AND has_function_privilege('authenticated', oid::oid, 'EXECUTE')) AS "authenticatedEffectiveExecute",
        (SELECT count(*)::int FROM resolved
          INNER JOIN pg_proc AS procedure ON procedure.oid = resolved.oid::oid
          CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
            AND acl.privilege_type = 'EXECUTE') AS "authenticatedExplicitExecute"
    `;
    if (sourceBoundary?.unsafeAttributes !== 0
      || sourceBoundary.missingFunctions !== 0
      || sourceBoundary.unexpectedOverloads !== 0
      || sourceBoundary.invalidFunctionDefinitions !== 0
      || sourceBoundary.serviceTablePrivileges !== 0
      || sourceBoundary.serviceSequencePrivileges !== 0
      || sourceBoundary.serviceCanCreateSchema
      || sourceBoundary.serviceFunctionPrivileges !== 4
      || sourceBoundary.extraServiceFunctionGrants !== 0
      || sourceBoundary.maintenanceFunctionOwnerships !== 4
      || sourceBoundary.publicAclExecute !== 0
      || sourceBoundary.publicExplicitExecute !== 0
      || sourceBoundary.anonEffectiveExecute !== 0
      || sourceBoundary.anonExplicitExecute !== 0
      || sourceBoundary.authenticatedEffectiveExecute !== 0
      || sourceBoundary.authenticatedExplicitExecute !== 0) {
      throw new Error(`WP-10 source role/privacy boundary is invalid: ${JSON.stringify(sourceBoundary)}.`);
    }

    const [submissionServicePrivileges] = await sql<{
      cleanupCorrectlyDefined: boolean;
      cleanupExecute: boolean;
      forbiddenOwnerships: number;
      hasSchemaUsage: boolean;
      leastPrivileged: boolean;
      missingColumnPrivileges: number;
      missingTablePrivileges: number;
      noInherit: boolean;
      unexpectedColumnPrivileges: number;
      unexpectedFunctionPrivileges: number;
      unexpectedTablePrivileges: number;
    }[]>`
      WITH expected_table_privileges(table_name, privilege_type) AS (
        VALUES
          ('submissions', 'SELECT'),
          ('submission_idempotency_bindings', 'SELECT'),
          ('submission_intake_contacts', 'SELECT'),
          ('submission_email_follow_ups', 'SELECT'),
          ('submission_rate_limit_buckets', 'SELECT'),
          ('submission_rate_limit_buckets', 'DELETE'),
          ('submission_hmac_key_pin', 'SELECT')
          ,('private_media_upload_sessions', 'SELECT')
          ,('private_media_consents', 'SELECT')
          ,('private_media_assets', 'SELECT')
          ,('private_media_derivatives', 'SELECT')
          ,('private_media_pending_objects', 'SELECT')
          ,('private_media_pending_objects', 'DELETE')
      ), expected_column_privileges(table_name, column_name, privilege_type) AS (
        VALUES
          ('submissions', 'kind', 'INSERT'),
          ('submissions', 'payload', 'INSERT'),
          ('submissions', 'intake_version', 'INSERT'),
          ('submissions', 'hmac_version', 'INSERT'),
          ('submissions', 'contributor_key', 'INSERT'),
          ('submissions', 'content_fingerprint', 'INSERT'),
          ('submission_idempotency_bindings', 'kind', 'INSERT'),
          ('submission_idempotency_bindings', 'idempotency_actor_key', 'INSERT'),
          ('submission_idempotency_bindings', 'idempotency_key_hash', 'INSERT'),
          ('submission_idempotency_bindings', 'submission_id', 'INSERT'),
          ('submission_idempotency_bindings', 'receipt_id', 'INSERT'),
          ('submission_idempotency_bindings', 'intake_version', 'INSERT'),
          ('submission_idempotency_bindings', 'hmac_version', 'INSERT'),
          ('submission_idempotency_bindings', 'request_fingerprint', 'INSERT'),
          ('submission_idempotency_bindings', 'payload', 'INSERT'),
          ('submission_idempotency_bindings', 'privacy_consent', 'INSERT'),
          ('submission_idempotency_bindings', 'contribution_consent', 'INSERT'),
          ('submission_idempotency_bindings', 'email_follow_up_consent', 'INSERT'),
          ('submission_idempotency_bindings', 'contributor_terms_version', 'INSERT'),
          ('submission_idempotency_bindings', 'privacy_notice_version', 'INSERT'),
          ('submission_idempotency_bindings', 'contact_consent_version', 'INSERT'),
          ('submission_idempotency_bindings', 'retention_policy_version', 'INSERT'),
          ('submission_idempotency_bindings', 'accepted_at', 'INSERT'),
          ('submission_idempotency_bindings', 'challenge_provider', 'INSERT'),
          ('submission_idempotency_bindings', 'challenge_verified_at', 'INSERT'),
          ('submission_idempotency_bindings', 'contact_present', 'INSERT'),
          ('submission_idempotency_bindings', 'contact_digest', 'INSERT'),
          ('submission_idempotency_bindings', 'retention_expires_at', 'INSERT'),
          ('submission_idempotency_bindings', 'contact_retention_expires_at', 'INSERT'),
          ('submission_intake_contacts', 'intake_id', 'INSERT'),
          ('submission_intake_contacts', 'contact_present', 'INSERT'),
          ('submission_intake_contacts', 'contact_digest', 'INSERT'),
          ('submission_intake_contacts', 'contact_email', 'INSERT'),
          ('submission_email_follow_ups', 'intake_id', 'INSERT'),
          ('submission_email_follow_ups', 'submission_id', 'INSERT'),
          ('submission_email_follow_ups', 'follow_up_key', 'INSERT'),
          ('submission_email_follow_ups', 'qualifying_event', 'INSERT'),
          ('submission_email_follow_ups', 'template_key', 'INSERT'),
          ('submission_email_follow_ups', 'available_at', 'INSERT'),
          ('submission_rate_limit_buckets', 'scope', 'INSERT'),
          ('submission_rate_limit_buckets', 'subject_hash', 'INSERT'),
          ('submission_rate_limit_buckets', 'window_started_at', 'INSERT'),
          ('submission_rate_limit_buckets', 'window_seconds', 'INSERT'),
          ('submission_rate_limit_buckets', 'expires_at', 'INSERT'),
          ('submission_rate_limit_buckets', 'request_count', 'UPDATE'),
          ('submission_rate_limit_buckets', 'updated_at', 'UPDATE')
          ,('private_media_upload_sessions', 'public_id', 'INSERT')
          ,('private_media_upload_sessions', 'intake_id', 'INSERT')
          ,('private_media_upload_sessions', 'kind', 'INSERT')
          ,('private_media_upload_sessions', 'purpose', 'INSERT')
          ,('private_media_upload_sessions', 'quarantine_object_path', 'INSERT')
          ,('private_media_upload_sessions', 'claimed_mime_type', 'INSERT')
          ,('private_media_upload_sessions', 'claimed_extension', 'INSERT')
          ,('private_media_upload_sessions', 'claimed_bytes', 'INSERT')
          ,('private_media_upload_sessions', 'capability_nonce_hash', 'INSERT')
          ,('private_media_upload_sessions', 'capability_expires_at', 'INSERT')
          ,('private_media_upload_sessions', 'status', 'UPDATE')
          ,('private_media_upload_sessions', 'capability_nonce_hash', 'UPDATE')
          ,('private_media_upload_sessions', 'capability_expires_at', 'UPDATE')
          ,('private_media_upload_sessions', 'finalize_capability_expires_at', 'UPDATE')
          ,('private_media_upload_sessions', 'uploaded_at', 'UPDATE')
          ,('private_media_upload_sessions', 'processing_lease_token', 'UPDATE')
          ,('private_media_upload_sessions', 'processing_lease_expires_at', 'UPDATE')
          ,('private_media_upload_sessions', 'finalized_at', 'UPDATE')
          ,('private_media_upload_sessions', 'terminal_error_code', 'UPDATE')
          ,('private_media_upload_sessions', 'updated_at', 'UPDATE')
          ,('private_media_consents', 'session_id', 'INSERT')
          ,('private_media_consents', 'intake_id', 'INSERT')
          ,('private_media_consents', 'owns_or_has_permission', 'INSERT')
          ,('private_media_consents', 'private_storage_consent', 'INSERT')
          ,('private_media_consents', 'derivative_processing_consent', 'INSERT')
          ,('private_media_consents', 'public_display_consent', 'INSERT')
          ,('private_media_consents', 'terms_version', 'INSERT')
          ,('private_media_consents', 'privacy_version', 'INSERT')
          ,('private_media_consents', 'retention_version', 'INSERT')
          ,('private_media_consents', 'accepted_at', 'INSERT')
          ,('private_media_consents', 'retention_deadline', 'INSERT')
          ,('private_media_assets', 'session_id', 'INSERT')
          ,('private_media_assets', 'intake_id', 'INSERT')
          ,('private_media_assets', 'checksum_sha256', 'INSERT')
          ,('private_media_assets', 'detected_mime_type', 'INSERT')
          ,('private_media_assets', 'source_bytes', 'INSERT')
          ,('private_media_assets', 'source_width', 'INSERT')
          ,('private_media_assets', 'source_height', 'INSERT')
          ,('private_media_assets', 'retention_deadline', 'INSERT')
          ,('private_media_derivatives', 'asset_id', 'INSERT')
          ,('private_media_derivatives', 'kind', 'INSERT')
          ,('private_media_derivatives', 'object_path', 'INSERT')
          ,('private_media_derivatives', 'checksum_sha256', 'INSERT')
          ,('private_media_derivatives', 'mime_type', 'INSERT')
          ,('private_media_derivatives', 'bytes', 'INSERT')
          ,('private_media_derivatives', 'width', 'INSERT')
          ,('private_media_derivatives', 'height', 'INSERT')
          ,('private_media_pending_objects', 'session_id', 'INSERT')
          ,('private_media_pending_objects', 'kind', 'INSERT')
          ,('private_media_pending_objects', 'object_path', 'INSERT')
          ,('private_media_pending_objects', 'delete_after', 'INSERT')
      ), actual_table_privileges AS (
        SELECT table_name, privilege_type
        FROM information_schema.table_privileges
        WHERE grantee = 'repairprint_submission_service' AND table_schema = 'public'
      ), actual_column_privileges AS (
        SELECT
          relation.relname::text AS table_name,
          attribute.attname::text AS column_name,
          privilege.privilege_type
        FROM pg_attribute AS attribute
        INNER JOIN pg_class AS relation ON relation.oid = attribute.attrelid
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
        INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
        WHERE namespace.nspname = 'public'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND grantee_role.rolname = 'repairprint_submission_service'
      )
      SELECT
        has_schema_privilege(role.rolname, 'public', 'USAGE') AS "hasSchemaUsage",
        NOT role.rolinherit AS "noInherit",
        NOT (
          role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
          OR role.rolreplication OR role.rolbypassrls
        ) AS "leastPrivileged",
        (SELECT count(*)::int FROM expected_table_privileges AS expected
          WHERE NOT EXISTS (
            SELECT 1 FROM actual_table_privileges AS actual
            WHERE actual.table_name = expected.table_name
              AND actual.privilege_type = expected.privilege_type
          )) AS "missingTablePrivileges",
        (SELECT count(*)::int FROM actual_table_privileges AS actual
          WHERE NOT EXISTS (
            SELECT 1 FROM expected_table_privileges AS expected
            WHERE expected.table_name = actual.table_name
              AND expected.privilege_type = actual.privilege_type
          )) AS "unexpectedTablePrivileges",
        (SELECT count(*)::int FROM expected_column_privileges AS expected
          WHERE NOT EXISTS (
            SELECT 1 FROM actual_column_privileges AS actual
            WHERE actual.table_name = expected.table_name
              AND actual.column_name = expected.column_name
              AND actual.privilege_type = expected.privilege_type
          )) AS "missingColumnPrivileges",
        (SELECT count(*)::int FROM actual_column_privileges AS actual
          WHERE NOT EXISTS (
            SELECT 1 FROM expected_column_privileges AS expected
            WHERE expected.table_name = actual.table_name
              AND expected.column_name = actual.column_name
              AND expected.privilege_type = actual.privilege_type
          )) AS "unexpectedColumnPrivileges",
        has_function_privilege(
          role.rolname,
          'public.cleanup_expired_submission_intakes(integer)',
          'EXECUTE'
        ) AS "cleanupExecute",
        EXISTS (
          SELECT 1
          FROM pg_proc AS procedure
          INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
          WHERE procedure.oid = to_regprocedure('public.cleanup_expired_submission_intakes(integer)')
            AND namespace.nspname = 'public'
            AND procedure.prosecdef
            AND procedure.proconfig @> ARRAY['search_path=pg_catalog']::text[]
            AND owner_role.rolname = 'repairprint_submission_maintenance'
        ) AS "cleanupCorrectlyDefined",
        (SELECT count(*)::int
          FROM information_schema.routine_privileges
          WHERE grantee = role.rolname
            AND routine_schema = 'public'
            AND NOT (
              routine_name IN ('cleanup_expired_submission_intakes', 'claim_expired_private_media', 'complete_private_media_cleanup',
                'claim_private_media_quarantine_cleanup', 'complete_private_media_quarantine_cleanup',
                'claim_private_media_pending_object_cleanup', 'complete_private_media_pending_object_cleanup')
              AND privilege_type = 'EXECUTE'
            )) AS "unexpectedFunctionPrivileges",
        (
          (SELECT count(*)::int FROM pg_database AS database
            WHERE database.datname = current_database() AND database.datdba = role.oid)
          +
          (SELECT count(*)::int FROM pg_namespace AS namespace
            WHERE namespace.nspname = 'public' AND namespace.nspowner = role.oid)
          +
          (SELECT count(*)::int
            FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relowner = role.oid)
          +
          (SELECT count(*)::int
            FROM pg_proc AS procedure
            INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public' AND procedure.proowner = role.oid)
        ) AS "forbiddenOwnerships"
      FROM pg_roles AS role
      WHERE role.rolname = 'repairprint_submission_service'
    `;
    if (
      !submissionServicePrivileges?.hasSchemaUsage
      || !submissionServicePrivileges.leastPrivileged
      || !submissionServicePrivileges.noInherit
      || !submissionServicePrivileges.cleanupExecute
      || !submissionServicePrivileges.cleanupCorrectlyDefined
      || submissionServicePrivileges.missingTablePrivileges !== 0
      || submissionServicePrivileges.unexpectedTablePrivileges !== 0
      || submissionServicePrivileges.missingColumnPrivileges !== 0
      || submissionServicePrivileges.unexpectedColumnPrivileges !== 0
      || submissionServicePrivileges.unexpectedFunctionPrivileges !== 0
      || submissionServicePrivileges.forbiddenOwnerships !== 0
    ) {
      throw new Error(`Dedicated submission service privileges are invalid: ${JSON.stringify(submissionServicePrivileges)}.`);
    }

    const [maintenanceRole] = await sql<{
      forbiddenOwnerships: number;
      leastPrivileged: boolean;
      missingColumnPrivileges: number;
      missingTablePrivileges: number;
      noInherit: boolean;
      noLogin: boolean;
      unexpectedColumnPrivileges: number;
      unexpectedTablePrivileges: number;
    }[]>`
      WITH expected_table_privileges(table_name, privilege_type) AS (
        SELECT relation_name, privilege_type
        FROM (VALUES
          ('submissions'),
          ('submission_idempotency_bindings'),
          ('submission_intake_contacts'),
          ('submission_email_follow_ups')
          ,('private_media_upload_sessions')
          ,('private_media_consents')
          ,('private_media_assets')
          ,('private_media_derivatives')
          ,('private_media_redactions')
          ,('private_media_pending_objects')
        ) AS relation(relation_name)
        CROSS JOIN (VALUES ('SELECT'), ('DELETE')) AS privilege(privilege_type)
      ), expected_column_privileges(table_name, column_name, privilege_type) AS (
        VALUES
          ('submissions', 'updated_at', 'UPDATE'),
          ('submission_idempotency_bindings', 'request_fingerprint', 'UPDATE'),
          ('private_media_upload_sessions', 'cleanup_lease_token', 'UPDATE'),
          ('private_media_upload_sessions', 'cleanup_lease_expires_at', 'UPDATE'),
          ('private_media_upload_sessions', 'status', 'UPDATE'),
          ('private_media_upload_sessions', 'terminal_error_code', 'UPDATE'),
          ('private_media_upload_sessions', 'processing_lease_token', 'UPDATE'),
          ('private_media_upload_sessions', 'processing_lease_expires_at', 'UPDATE'),
          ('private_media_upload_sessions', 'finalized_at', 'UPDATE'),
          ('private_media_upload_sessions', 'updated_at', 'UPDATE')
          ,('private_media_pending_objects', 'cleanup_lease_token', 'UPDATE')
          ,('private_media_pending_objects', 'cleanup_lease_expires_at', 'UPDATE')
      ), actual_table_privileges AS (
        SELECT table_name, privilege_type
        FROM information_schema.table_privileges
        WHERE grantee = 'repairprint_submission_maintenance' AND table_schema = 'public'
      ), actual_column_privileges AS (
        SELECT
          relation.relname::text AS table_name,
          attribute.attname::text AS column_name,
          privilege.privilege_type
        FROM pg_attribute AS attribute
        INNER JOIN pg_class AS relation ON relation.oid = attribute.attrelid
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
        INNER JOIN pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
        WHERE namespace.nspname = 'public'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND grantee_role.rolname = 'repairprint_submission_maintenance'
      )
      SELECT
        NOT role.rolcanlogin AS "noLogin",
        NOT role.rolinherit AS "noInherit",
        NOT (
          role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
          OR role.rolreplication OR role.rolbypassrls
        ) AS "leastPrivileged",
        (SELECT count(*)::int FROM expected_table_privileges AS expected
          WHERE NOT EXISTS (SELECT 1 FROM actual_table_privileges AS actual
            WHERE actual.table_name = expected.table_name
              AND actual.privilege_type = expected.privilege_type)) AS "missingTablePrivileges",
        (SELECT count(*)::int FROM actual_table_privileges AS actual
          WHERE NOT EXISTS (SELECT 1 FROM expected_table_privileges AS expected
            WHERE expected.table_name = actual.table_name
              AND expected.privilege_type = actual.privilege_type)) AS "unexpectedTablePrivileges",
        (SELECT count(*)::int FROM expected_column_privileges AS expected
          WHERE NOT EXISTS (SELECT 1 FROM actual_column_privileges AS actual
            WHERE actual.table_name = expected.table_name
              AND actual.column_name = expected.column_name
              AND actual.privilege_type = expected.privilege_type)) AS "missingColumnPrivileges",
        (SELECT count(*)::int FROM actual_column_privileges AS actual
          WHERE NOT EXISTS (SELECT 1 FROM expected_column_privileges AS expected
            WHERE expected.table_name = actual.table_name
              AND expected.column_name = actual.column_name
              AND expected.privilege_type = actual.privilege_type)) AS "unexpectedColumnPrivileges",
        (
          (SELECT count(*)::int FROM pg_database AS database
            WHERE database.datname = current_database() AND database.datdba = role.oid)
          + (SELECT count(*)::int FROM pg_namespace AS namespace
            WHERE namespace.nspname = 'public' AND namespace.nspowner = role.oid)
          + (SELECT count(*)::int FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relowner = role.oid)
          + (SELECT count(*)::int FROM pg_proc AS procedure
            INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proowner = role.oid
              AND procedure.oid NOT IN (
                to_regprocedure('public.cleanup_expired_submission_intakes(integer)'),
                to_regprocedure('public.claim_expired_private_media(integer,uuid)'),
                to_regprocedure('public.complete_private_media_cleanup(uuid,uuid[])')
                ,to_regprocedure('public.claim_private_media_quarantine_cleanup(integer,uuid)')
                ,to_regprocedure('public.complete_private_media_quarantine_cleanup(uuid,uuid[])')
                ,to_regprocedure('public.claim_private_media_pending_object_cleanup(integer,uuid)')
                ,to_regprocedure('public.complete_private_media_pending_object_cleanup(uuid,uuid[])')
              ))
        ) AS "forbiddenOwnerships"
      FROM pg_roles AS role
      WHERE role.rolname = 'repairprint_submission_maintenance'
    `;
    if (
      !maintenanceRole?.noLogin
      || !maintenanceRole.noInherit
      || !maintenanceRole.leastPrivileged
      || maintenanceRole.missingTablePrivileges !== 0
      || maintenanceRole.unexpectedTablePrivileges !== 0
      || maintenanceRole.missingColumnPrivileges !== 0
      || maintenanceRole.unexpectedColumnPrivileges !== 0
      || maintenanceRole.forbiddenOwnerships !== 0
    ) {
      throw new Error(`Submission maintenance role boundary is invalid: ${JSON.stringify(maintenanceRole)}.`);
    }

    const expectedContributionTriggers = [
      "submission_intake_contacts_immutable_row_trg",
      "submission_intake_contacts_immutable_truncate_trg",
      "submission_intakes_immutable_row_trg",
      "submission_intakes_immutable_truncate_trg",
      "submission_intakes_preserve_parent_graph_trg",
      "submission_intakes_require_contact_trg",
      "submission_follow_ups_eligibility_trg",
      "submissions_parent_delete_trg",
      "submissions_parent_truncate_trg",
      "submissions_require_intake_trg",
    ] as const;
    const contributionTriggers = await sql<{ triggerName: string }[]>`
      SELECT trigger.tgname AS "triggerName"
      FROM pg_trigger AS trigger
      INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND trigger.tgname::text = ANY(${expectedContributionTriggers}::text[])
        AND trigger.tgenabled = 'O'
        AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname
    `;
    if (
      contributionTriggers.map((row) => row.triggerName).join(",")
      !== [...expectedContributionTriggers].sort().join(",")
    ) {
      throw new Error(
        `The immutable contribution graph trigger set is incomplete: ${contributionTriggers.map((row) => row.triggerName).join(", ") || "none"}.`,
      );
    }

    const [contributionAudit] = await sql<{
      dependentRowsWithoutPin: number;
      expiredContacts: number;
      expiredIntakes: number;
      invalidContacts: number;
      invalidFollowUps: number;
      invalidHmacParents: number;
      invalidIntakes: number;
      invalidPins: number;
      invalidRateBuckets: number;
      legacyPrivatePayloads: number;
      missingContacts: number;
      pinRows: number;
      unboundVersionOne: number;
      unexpectedContacts: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submission_hmac_key_pin) AS "pinRows",
        (SELECT count(*)::int FROM submission_hmac_key_pin AS pin
          WHERE NOT pin.singleton
            OR pin.hmac_version <> 'hmac-sha256/v1'
            OR pin.key_commitment !~ '^[0-9a-f]{64}$') AS "invalidPins",
        (SELECT count(*)::int
          FROM (VALUES
            ((SELECT count(*) FROM submissions WHERE intake_version = 1)),
            ((SELECT count(*) FROM submission_idempotency_bindings)),
            ((SELECT count(*) FROM submission_intake_contacts)),
            ((SELECT count(*) FROM submission_email_follow_ups)),
            ((SELECT count(*) FROM submission_rate_limit_buckets))
          ) AS dependency(row_count)
          WHERE dependency.row_count > 0
            AND (SELECT count(*) FROM submission_hmac_key_pin) <> 1) AS "dependentRowsWithoutPin",
        (SELECT count(*)::int FROM submissions AS submission
          LEFT JOIN submission_hmac_key_pin AS pin
            ON pin.singleton = true AND pin.hmac_version = submission.hmac_version
          WHERE submission.intake_version = 1 AND (
            submission.hmac_version <> 'hmac-sha256/v1'
            OR submission.contributor_key IS NULL
            OR submission.contributor_key !~ '^[0-9a-f]{64}$'
            OR submission.content_fingerprint IS NULL
            OR submission.content_fingerprint !~ '^[0-9a-f]{64}$'
            OR pin.singleton IS NULL
            OR submission.payload ?| ARRAY[
              'email', 'contactEmail', 'evidenceUrl', 'modificationNotes', 'printSettings',
              'notes', 'privacyConsent', 'contributionConsent', 'emailFollowUpConsent',
              'contributorTermsVersion', 'privacyNoticeVersion', 'contactConsentVersion',
              'retentionPolicyVersion', 'idempotencyKey', 'turnstileToken'
            ]
          )) AS "invalidHmacParents",
        (SELECT count(*)::int FROM submissions AS submission
          WHERE submission.intake_version = 1
            AND NOT EXISTS (
              SELECT 1 FROM submission_idempotency_bindings AS intake
              WHERE intake.submission_id = submission.id
                AND intake.kind = submission.kind
                AND intake.intake_version = submission.intake_version
                AND intake.hmac_version = submission.hmac_version
                AND intake.receipt_id = submission.receipt_id
            )) AS "unboundVersionOne",
        (SELECT count(*)::int FROM submission_idempotency_bindings AS intake
          LEFT JOIN submissions AS submission
            ON submission.id = intake.submission_id
            AND submission.kind = intake.kind
            AND submission.intake_version = intake.intake_version
            AND submission.hmac_version = intake.hmac_version
            AND submission.receipt_id = intake.receipt_id
          LEFT JOIN submission_hmac_key_pin AS pin
            ON pin.singleton = true AND pin.hmac_version = intake.hmac_version
          WHERE submission.id IS NULL
            OR pin.singleton IS NULL
            OR intake.intake_version <> 1
            OR intake.hmac_version <> 'hmac-sha256/v1'
            OR intake.idempotency_actor_key IS NULL
            OR intake.idempotency_actor_key !~ '^[0-9a-f]{64}$'
            OR intake.idempotency_key_hash IS NULL
            OR intake.idempotency_key_hash !~ '^[0-9a-f]{64}$'
            OR intake.request_fingerprint IS NULL
            OR intake.request_fingerprint !~ '^[0-9a-f]{64}$'
            OR NOT intake.privacy_consent
            OR NOT intake.contribution_consent
            OR (intake.contact_present AND NOT intake.email_follow_up_consent)
            OR length(intake.contributor_terms_version) = 0
            OR length(intake.privacy_notice_version) = 0
            OR length(intake.contact_consent_version) = 0
            OR length(intake.retention_policy_version) = 0
            OR intake.challenge_provider <> 'turnstile'
            OR intake.challenge_verified_at > intake.accepted_at
            OR intake.retention_expires_at <= intake.accepted_at
            OR (
              NOT intake.contact_present AND (
                intake.contact_digest IS NOT NULL OR intake.contact_retention_expires_at IS NOT NULL
              )
            )
            OR (
              intake.contact_present AND (
                intake.contact_digest IS NULL
                OR intake.contact_digest !~ '^[0-9a-f]{64}$'
                OR intake.contact_retention_expires_at IS NULL
                OR intake.contact_retention_expires_at <= intake.accepted_at
                OR intake.contact_retention_expires_at > intake.retention_expires_at
              )
            )) AS "invalidIntakes",
        (SELECT count(*)::int FROM submission_intake_contacts AS contact
          LEFT JOIN submission_idempotency_bindings AS intake
            ON intake.id = contact.intake_id
            AND intake.contact_present = contact.contact_present
            AND intake.contact_digest = contact.contact_digest
          WHERE intake.id IS NULL
            OR NOT contact.contact_present
            OR contact.contact_digest !~ '^[0-9a-f]{64}$'
            OR char_length(contact.contact_email) NOT BETWEEN 3 AND 320) AS "invalidContacts",
        (SELECT count(*)::int FROM submission_idempotency_bindings AS intake
          WHERE intake.contact_present
            AND intake.contact_retention_expires_at > pg_catalog.clock_timestamp()
            AND NOT EXISTS (
            SELECT 1 FROM submission_intake_contacts AS contact
            WHERE contact.intake_id = intake.id
              AND contact.contact_digest = intake.contact_digest
          )) AS "missingContacts",
        (SELECT count(*)::int FROM submission_idempotency_bindings AS intake
          WHERE NOT intake.contact_present AND EXISTS (
            SELECT 1 FROM submission_intake_contacts AS contact WHERE contact.intake_id = intake.id
          )) AS "unexpectedContacts",
        (SELECT count(*)::int FROM submission_email_follow_ups AS follow_up
          LEFT JOIN submission_idempotency_bindings AS intake
            ON intake.id = follow_up.intake_id AND intake.submission_id = follow_up.submission_id
          LEFT JOIN submission_intake_contacts AS contact ON contact.intake_id = follow_up.intake_id
          WHERE intake.id IS NULL
            OR contact.intake_id IS NULL
            OR NOT intake.contact_present
            OR NOT intake.email_follow_up_consent
            OR follow_up.follow_up_key !~ (
              '^intake:' || follow_up.intake_id::text || ':' || follow_up.qualifying_event
              || ':[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
            OR follow_up.available_at < intake.accepted_at
            OR intake.contact_retention_expires_at <= follow_up.available_at
            OR intake.retention_expires_at <= follow_up.available_at
            OR (follow_up.qualifying_event = 'matching_publication' AND (
              intake.kind <> 'missing_part' OR follow_up.template_key <> 'missing-part-match-alert'
            ))
            OR (follow_up.qualifying_event = 'moderator_question'
              AND follow_up.template_key <> 'moderator-follow-up')) AS "invalidFollowUps",
        (SELECT count(*)::int FROM submission_rate_limit_buckets
          WHERE request_count < 1 OR window_seconds < 1 OR expires_at <= window_started_at) AS "invalidRateBuckets",
        (SELECT count(*)::int FROM submissions
          WHERE intake_version = 0 AND payload ?| ARRAY[
            'email', 'contactEmail', 'contact', 'idempotencyKey', 'turnstileToken'
          ]) AS "legacyPrivatePayloads",
        (SELECT count(*)::int FROM submission_idempotency_bindings
          WHERE retention_expires_at <= pg_catalog.clock_timestamp()) AS "expiredIntakes",
        (SELECT count(*)::int FROM submission_intake_contacts AS contact
          INNER JOIN submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          WHERE intake.contact_retention_expires_at <= pg_catalog.clock_timestamp()
            OR intake.retention_expires_at <= pg_catalog.clock_timestamp()) AS "expiredContacts"
    `;
    if (
      !contributionAudit
      || contributionAudit.pinRows > 1
      || contributionAudit.invalidPins !== 0
      || contributionAudit.dependentRowsWithoutPin !== 0
      || contributionAudit.invalidHmacParents !== 0
      || contributionAudit.unboundVersionOne !== 0
      || contributionAudit.invalidIntakes !== 0
      || contributionAudit.invalidContacts !== 0
      || contributionAudit.missingContacts !== 0
      || contributionAudit.unexpectedContacts !== 0
      || contributionAudit.invalidFollowUps !== 0
      || contributionAudit.invalidRateBuckets !== 0
      || contributionAudit.legacyPrivatePayloads !== 0
      || contributionAudit.expiredIntakes !== 0
      || contributionAudit.expiredContacts !== 0
    ) {
      throw new Error(`Anonymous contribution staging audit failed: ${JSON.stringify(contributionAudit)}.`);
    }

    const [mediaAudit] = await sql<{
      invalidFunctions: number;
      invalidRows: number;
      missingConsent: number;
      publicRelationLeaks: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM private_media_upload_sessions AS session
          LEFT JOIN submission_idempotency_bindings AS intake
            ON intake.id = session.intake_id AND intake.kind = session.kind
          WHERE intake.id IS NULL OR session.claimed_bytes NOT BETWEEN 1 AND 10485760
            OR session.quarantine_object_path !~ '^quarantine/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}$')
        + (SELECT count(*)::int FROM private_media_pending_objects AS pending
          LEFT JOIN private_media_upload_sessions AS session ON session.id = pending.session_id
          WHERE session.id IS NULL
            OR pending.object_path !~ '^private/[0-9a-f]{2}/[A-Za-z0-9_-]{22,128}/(master|thumbnail|redacted)-[0-9a-f]{64}\.webp$') AS "invalidRows",
        (SELECT count(*)::int FROM private_media_upload_sessions AS session
          WHERE NOT EXISTS (SELECT 1 FROM private_media_consents AS consent
            WHERE consent.session_id = session.id AND consent.intake_id = session.intake_id)) AS "missingConsent",
        (SELECT count(*)::int FROM pg_proc AS procedure
          INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
          WHERE procedure.oid = ANY(ARRAY[
            to_regprocedure('public.claim_expired_private_media(integer,uuid)'),
            to_regprocedure('public.complete_private_media_cleanup(uuid,uuid[])'),
            to_regprocedure('public.claim_private_media_quarantine_cleanup(integer,uuid)'),
            to_regprocedure('public.complete_private_media_quarantine_cleanup(uuid,uuid[])')
            ,to_regprocedure('public.claim_private_media_pending_object_cleanup(integer,uuid)')
            ,to_regprocedure('public.complete_private_media_pending_object_cleanup(uuid,uuid[])')
          ]) AND (NOT procedure.prosecdef OR NOT procedure.proconfig @> ARRAY['search_path=pg_catalog']::text[]
            OR owner_role.rolname <> 'repairprint_submission_maintenance')) AS "invalidFunctions",
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN
            ('public_catalogue_fitments', 'public_catalogue_unavailable_sources', 'public_search_documents')
            AND column_name IN ('intake_id', 'quarantine_object_path', 'object_path', 'retention_deadline',
              'public_display_consent', 'rectangles', 'reviewed_by')) AS "publicRelationLeaks"
    `;
    if (!mediaAudit || mediaAudit.invalidRows !== 0 || mediaAudit.missingConsent !== 0
      || mediaAudit.invalidFunctions !== 0 || mediaAudit.publicRelationLeaks !== 0) {
      throw new Error(`Private media staging audit failed: ${JSON.stringify(mediaAudit)}.`);
    }

    console.log(
      `Staging pg_trgm baseline verified: ${verifiedPgTrgmRoutineCount} routines; `
      + `sha256=${verifiedPgTrgmFingerprint}.`,
    );
    console.log(
      "Staging foundation verified: 38 private base tables, 4 non-public legacy views, 2 safe catalogue views, "
      + "1 safe search view, private aggregate-only analytics, immutable versioned contribution intakes, "
      + "pinned HMAC framing, least-privilege cleanup, and immutable audit.",
    );
  } finally {
    let rollbackFailed = false;
    if (auditTransactionOpen) {
      try {
        await sql.unsafe("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    await sql.end();
    if (rollbackFailed) throw new Error("PG_TRGM_STAGING_ROLLBACK_FAILED");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("PG_TRGM_STAGING_")) {
    console.error(message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
