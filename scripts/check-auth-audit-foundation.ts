import postgres from "postgres";

const publishedViews = [
  "published_brands",
  "published_designs",
  "published_fitments",
  "published_product_models",
] as const;
const catalogueViews = ["public_catalogue_fitments", "public_catalogue_unavailable_sources"] as const;

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
    if (tables?.count !== 28) throw new Error(`Expected 28 public tables, found ${tables?.count}.`);
    const [enums] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND type.typtype = 'e'
    `;
    if (enums?.count !== 16) throw new Error(`Expected 16 public enums, found ${enums?.count}.`);

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
          'payload', 'email', 'contact_email', 'contributor_key', 'idempotency_key_hash',
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

    const [privateContributionPrivileges] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM (VALUES ('anon'), ('authenticated')) AS required_role(role_name)
      CROSS JOIN (VALUES
        ('submissions'),
        ('submission_email_follow_ups'),
        ('submission_rate_limit_buckets')
      ) AS private_relation(relation_name)
      WHERE has_table_privilege(
        required_role.role_name,
        format('public.%I', private_relation.relation_name),
        'SELECT,INSERT,UPDATE,DELETE'
      )
    `;
    if (privateContributionPrivileges?.count !== 0) {
      throw new Error("Anonymous roles can bypass the server-only contribution queue boundary.");
    }

    const [contributionAudit] = await sql<{
      invalidFollowUps: number;
      invalidRateBuckets: number;
      invalidVersionOne: number;
      legacyEmails: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submission_email_follow_ups AS follow_up
          LEFT JOIN submissions AS submission ON submission.id = follow_up.submission_id
          WHERE submission.id IS NULL
            OR submission.contact_email IS NULL
            OR submission.contact_consent_version IS NULL
            OR submission.contact_consented_at IS NULL
            OR (submission.kind = 'missing_part' AND follow_up.template_key <> 'missing-part-match-alert')
            OR (submission.kind IN ('fit_confirmation', 'design_submission') AND follow_up.template_key <> 'moderator-follow-up')
            OR (follow_up.status = 'awaiting_event' AND follow_up.available_at IS NOT NULL)
            OR (follow_up.status IN ('pending', 'processing', 'sent', 'failed') AND follow_up.available_at IS NULL)) AS "invalidFollowUps",
        (SELECT count(*)::int FROM submission_rate_limit_buckets
          WHERE request_count < 1 OR window_seconds < 1 OR expires_at <= window_started_at) AS "invalidRateBuckets",
        (SELECT count(*)::int FROM submissions
          WHERE intake_version = 1 AND (
            idempotency_key_hash IS NULL OR request_fingerprint IS NULL OR contributor_key IS NULL
            OR content_fingerprint IS NULL OR contributor_terms_version IS NULL
            OR privacy_notice_version IS NULL OR consented_at IS NULL
            OR challenge_provider <> 'turnstile' OR challenge_verified_at IS NULL
          )) AS "invalidVersionOne",
        (SELECT count(*)::int FROM submissions
          WHERE intake_version = 0 AND coalesce(payload->>'email', '') <> '') AS "legacyEmails"
    `;
    if (
      contributionAudit?.invalidFollowUps !== 0
      || contributionAudit.invalidRateBuckets !== 0
      || contributionAudit.invalidVersionOne !== 0
      || contributionAudit.legacyEmails !== 0
    ) {
      throw new Error(`Anonymous contribution staging audit failed: ${JSON.stringify(contributionAudit)}.`);
    }

    console.log("Staging foundation verified: 28 private base tables, 4 non-public legacy views, 2 safe catalogue views, 1 safe search view, versioned private contributions, and immutable audit.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
