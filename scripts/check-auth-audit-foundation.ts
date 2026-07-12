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
    if (tables?.count !== 26) throw new Error(`Expected 26 public tables, found ${tables?.count}.`);

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
    if (publishedViewGrants?.count !== publishedViews.length * 2) {
      throw new Error("anon and authenticated must have SELECT on all four published-only views.");
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

    console.log("Staging foundation verified: 26 tables, 4 entity views, 2 catalogue views, 1 search view, immutable audit, published-only access.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
