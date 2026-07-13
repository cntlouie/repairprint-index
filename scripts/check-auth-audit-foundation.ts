import postgres from "postgres";

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
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the staging foundation check.");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  try {
    const [tables] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    if (tables?.count !== 43) throw new Error(`Expected 43 public tables, found ${tables?.count}.`);
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
      cleanupPrivileges: number;
      relationPrivileges: number;
    }[]>`
      SELECT
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

    const [sourceBoundary] = await sql<{
      maintenanceFunctionOwnerships: number;
      unsafeAttributes: number;
      serviceFunctionPrivileges: number;
      serviceTablePrivileges: number;
      publicFunctionPrivileges: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM pg_roles AS role
          WHERE (role.rolname = 'repairprint_source_service' AND (
              NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))
            OR (role.rolname = 'repairprint_source_maintenance' AND (
              role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolinherit OR role.rolreplication OR role.rolbypassrls))) AS "unsafeAttributes",
        (SELECT count(*)::int FROM information_schema.table_privileges
          WHERE table_schema = 'public' AND grantee = 'repairprint_source_service') AS "serviceTablePrivileges",
        (SELECT count(*)::int FROM information_schema.routine_privileges
          WHERE routine_schema = 'public' AND grantee = 'repairprint_source_service'
            AND privilege_type = 'EXECUTE'
            AND routine_name IN ('upsert_private_source_candidate', 'transition_source_candidate_version',
              'claim_source_link_check_jobs', 'complete_source_link_check')) AS "serviceFunctionPrivileges",
        (SELECT count(*)::int FROM pg_proc AS procedure
          INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          INNER JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
          WHERE namespace.nspname = 'public' AND owner_role.rolname = 'repairprint_source_maintenance'
            AND procedure.proname IN ('upsert_private_source_candidate', 'transition_source_candidate_version',
              'claim_source_link_check_jobs', 'complete_source_link_check')
            AND procedure.prosecdef AND procedure.proconfig @> ARRAY['search_path=pg_catalog']::text[]) AS "maintenanceFunctionOwnerships",
        (SELECT count(*)::int FROM information_schema.routine_privileges
          WHERE routine_schema = 'public' AND grantee IN ('PUBLIC', 'anon', 'authenticated')
            AND privilege_type = 'EXECUTE'
            AND routine_name IN ('upsert_private_source_candidate', 'transition_source_candidate_version',
              'claim_source_link_check_jobs', 'complete_source_link_check')) AS "publicFunctionPrivileges"
    `;
    if (sourceBoundary?.unsafeAttributes !== 0
      || sourceBoundary.serviceTablePrivileges !== 0
      || sourceBoundary.serviceFunctionPrivileges !== 4
      || sourceBoundary.maintenanceFunctionOwnerships !== 4
      || sourceBoundary.publicFunctionPrivileges !== 0) {
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
      "Staging foundation verified: 37 private base tables, 4 non-public legacy views, 2 safe catalogue views, "
      + "1 safe search view, immutable versioned contribution intakes, pinned HMAC framing, least-privilege cleanup, and immutable audit.",
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
