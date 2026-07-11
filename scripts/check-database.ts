import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { commitCandidateImport, prepareCandidateImport, queueCandidateImportReview } from "../src/db/imports";
import {
  archiveFitment,
  createCatalogTargetDraft,
  moderateEvidence,
  prepareCreatorSubmission,
  publishCreatorSubmission,
  reviewCreatorSubmission,
} from "../src/db/editorial";
import { loadImportPack } from "./load-import-pack";
import { seedDatabase, seedIds } from "./seed-data";
import * as schema from "../src/db/schema";

const seededTables = [
  "brands",
  "categories",
  "components",
  "creators",
  "design_revisions",
  "designs",
  "fitment_evidence",
  "fitments",
  "product_components",
  "product_identifiers",
  "product_models",
  "safety_reviews",
  "source_platform_policies",
  "sources",
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_TEST_URL is required for the destructive fresh-database check.");
  }

  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  const database = drizzle(sql, { schema });

  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await sql.unsafe('CREATE SCHEMA "public"');
    await migrate(database, { migrationsFolder: "drizzle" });
    await migrate(database, { migrationsFolder: "drizzle" });

    const tableRows = await sql<{ tableCount: number }[]>`
      SELECT count(*)::int AS "tableCount"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tableCount = tableRows[0]?.tableCount;
    if (tableCount !== 26) throw new Error(`Expected 26 public tables after migration, found ${tableCount}.`);

    const viewRows = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name LIKE 'published_%'
    `;
    if (viewRows[0]?.viewCount !== 4) throw new Error("Expected four published-only anonymous views.");

    const extensionRows = await sql<{ extensionCount: number }[]>`
      SELECT count(*)::int AS "extensionCount" FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    const extensionCount = extensionRows[0]?.extensionCount;
    if (extensionCount !== 1) throw new Error("pg_trgm extension was not installed by the migration.");

    await seedDatabase(database);
    await seedDatabase(database);

    for (const table of seededTables) {
      const rowCountRows = await sql.unsafe<{ rowCount: number }[]>(
        `SELECT count(*)::int AS "rowCount" FROM "${table}"`,
      );
      const rowCount = rowCountRows[0]?.rowCount;
      if (rowCount !== 1) throw new Error(`Expected one idempotent seed row in ${table}, found ${rowCount}.`);
    }

    const publishedRows = await sql<{ publishedCount: number }[]>`
      SELECT count(*)::int AS "publishedCount" FROM fitments WHERE publication_status = 'published'
    `;
    const publishedCount = publishedRows[0]?.publishedCount;
    if (publishedCount !== 0) throw new Error("The fictional seed must not publish a fitment.");

    const [staff] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000101', 'reviewer@example.invalid', 'reviewer', 'active', true)
      RETURNING id
    `;
    if (!staff) throw new Error("Staff profile fixture was not created.");

    const importFiles = loadImportPack("data/fixtures/phase0-demo");
    const dryRun = await prepareCandidateImport(database, importFiles);
    if (!dryRun.canCommit || dryRun.counts.insert !== 20) {
      throw new Error(`Expected the fictional Phase 0 dry run to accept 20 candidate rows: ${JSON.stringify(dryRun.errors)}`);
    }
    const firstImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture.",
      requestId: "req_import_gate_first",
    });
    const secondImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture rerun.",
      requestId: "req_import_gate_second",
    });
    if (firstImport.reused || !secondImport.reused || secondImport.runId !== firstImport.runId) {
      throw new Error("Repeated Phase 0 commit did not reuse the original import run.");
    }
    const [importCounts] = await sql<{ runs: number; rows: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs) AS runs,
        (SELECT count(*)::int FROM import_rows) AS rows
    `;
    if (importCounts?.runs !== 1 || importCounts.rows !== 20) {
      throw new Error(`Expected one import run and 20 candidate rows, found ${JSON.stringify(importCounts)}.`);
    }

    const ambiguousFiles = { ...importFiles };
    ambiguousFiles["product_identifiers.csv"] = ambiguousFiles["product_identifiers.csv"].replace(
      "DV-201-B,DV-201-B,DV201B",
      "DV201A,DV201A,DV201A",
    );
    const ambiguousDryRun = await prepareCandidateImport(database, ambiguousFiles);
    if (ambiguousDryRun.canCommit || !ambiguousDryRun.errors.some((entry) => entry.code === "MODEL_AMBIGUOUS")) {
      throw new Error("Ambiguous model collision did not block commit with MODEL_AMBIGUOUS.");
    }
    const queued = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture.",
      requestId: "req_import_collision_gate",
    });
    const queuedAgain = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture rerun.",
      requestId: "req_import_collision_gate_rerun",
    });
    if (queued.reused || !queuedAgain.reused || queuedAgain.runId !== queued.runId) {
      throw new Error("Repeated collision queue write did not reuse the original failed import run.");
    }
    const [collisionCounts] = await sql<{ failedRuns: number; collisions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs WHERE status = 'failed') AS "failedRuns",
        (SELECT count(*)::int FROM import_collisions WHERE status = 'open') AS collisions
    `;
    if (collisionCounts?.failedRuns !== 1 || collisionCounts.collisions < 1) {
      throw new Error(`Expected one failed run with an open collision, found ${JSON.stringify(collisionCounts)}.`);
    }

    const [editor] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000102', 'editor@example.invalid', 'editor', 'active', false)
      RETURNING id
    `;
    const [admin] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000103', 'admin@example.invalid', 'admin', 'active', true)
      RETURNING id
    `;
    if (!editor || !admin) throw new Error("Editorial staff fixtures were not created.");
    const editorIdentity = { id: editor.id, authUserId: "00000000-0000-4000-8000-000000000102", email: "editor@example.invalid", role: "editor" as const, status: "active" as const };
    const reviewerIdentity = { id: staff.id, authUserId: "00000000-0000-4000-8000-000000000101", email: "reviewer@example.invalid", role: "reviewer" as const, status: "active" as const };
    const adminIdentity = { id: admin.id, authUserId: "00000000-0000-4000-8000-000000000103", email: "admin@example.invalid", role: "admin" as const, status: "active" as const };

    const catalogDraft = await createCatalogTargetDraft(database, editorIdentity, {
      brandId: seedIds.brand,
      categoryId: seedIds.category,
      sourceId: seedIds.source,
      sourceLocator: "Fictional manual section 4.2",
      modelPublicId: "model_demo_dv_101",
      modelName: "DV-101 Demo Region B",
      modelSlug: "demovac-dv-101-demo-region-b",
      marketCodes: ["DEMO-B"],
      identifierDisplay: "DV-101-B",
      identifierType: "model_number",
      component: { mode: "existing", id: seedIds.component },
      oem: { mode: "new", publicId: "oem_demo_latch_101b", partNumberDisplay: "DEMO-LATCH-101-B", name: "Fictional dust-bin latch B" },
      reason: "Prepare a fictional exact catalog target with source-backed pending claims.",
      requestId: "req_catalog_prepare",
    });
    const [catalogCounts] = await sql<{ modelDrafts: number; pendingMappings: number; citations: number; auditEvents: number }[]>`
      SELECT
        (SELECT count(*)::int FROM product_models WHERE id = ${catalogDraft.productModelId} AND publication_status = 'draft') AS "modelDrafts",
        (SELECT count(*)::int FROM product_components WHERE id = ${catalogDraft.productComponentId} AND mapping_status = 'pending') AS "pendingMappings",
        (SELECT count(*)::int FROM source_citations WHERE entity_id IN (${catalogDraft.productModelId}, ${catalogDraft.productComponentId})) AS citations,
        (SELECT count(*)::int FROM audit_log WHERE action = 'catalog.target.prepare' AND entity_id = ${catalogDraft.productComponentId}) AS "auditEvents"
    `;
    if (catalogCounts?.modelDrafts !== 1 || catalogCounts.pendingMappings !== 1 || catalogCounts.citations !== 2 || catalogCounts.auditEvents !== 1) {
      throw new Error(`Catalog draft editor evidence is incomplete: ${JSON.stringify(catalogCounts)}.`);
    }

    const [creatorSubmission] = await database
      .insert(schema.submissions)
      .values({
        kind: "design_submission",
        status: "pending",
        payload: {
          sourceUrl: "https://example.invalid/editorial/publishable-latch",
          creatorName: "Fictional workflow creator",
          brand: "DemoVac",
          modelNumber: "DV-100",
          componentName: "Dust-bin latch",
          claimedLicense: "NOT-STATED",
          notes: "Fictional creator-listed exact-model claim.",
          email: "",
          website: "",
        },
      })
      .returning({ id: schema.submissions.id });
    if (!creatorSubmission) throw new Error("Creator submission fixture was not created.");

    const prepared = await prepareCreatorSubmission(database, creatorSubmission.id, editorIdentity, {
      productComponentId: seedIds.productComponent,
      confirmExactTarget: true,
      designTitle: "Fictional DV-100 latch workflow fixture",
      creatorPlatform: "example.invalid",
      sourcePlatform: "example.invalid",
      sourceExternalId: "editorial-publishable-latch",
      sourceRevision: "r1",
      sourceTitle: "Fictional creator landing page",
      licenseCode: "NOT-STATED",
      licenseVersion: "",
      licenseUrl: "",
      licenseEvidenceUrl: "https://example.invalid/editorial/publishable-latch",
      attributionText: "Fictional latch by Fictional workflow creator",
      fileFormats: ["STL"],
      observedAt: "2026-07-11",
      evidenceSummary: "Creator explicitly lists the exact fictional DV-100 model and r1 revision.",
      reason: "Prepare the fictional creator submission for independent review.",
      requestId: "req_editorial_prepare",
    });

    let selfReviewRejected = false;
    try {
      await reviewCreatorSubmission(database, creatorSubmission.id, editorIdentity, {
        decision: "accept",
        safetyClass: "low",
        safetySignals: ["low_load_clip"],
        safetyRationale: "Fictional low-load external latch.",
        reason: "Attempted self review fixture.",
        requestId: "req_editorial_self_review",
      });
    } catch (error) {
      selfReviewRejected = error instanceof Error && error.message === "SELF_REVIEW_FORBIDDEN";
    }
    if (!selfReviewRejected) throw new Error("Editor self-review was not rejected.");

    const reviewed = await reviewCreatorSubmission(database, creatorSubmission.id, reviewerIdentity, {
      decision: "accept",
      safetyClass: "low",
      safetySignals: ["low_load_clip"],
      safetyRationale: "Fictional low-load external latch; failure causes inconvenience only.",
      reason: "Independently reviewed source, rights, exact target, evidence, and safety.",
      requestId: "req_editorial_review",
    });
    if (reviewed.fitmentId !== prepared.fitmentId || reviewed.status !== "accepted") {
      throw new Error("Independent editorial review did not accept the prepared fitment.");
    }
    await publishCreatorSubmission(database, creatorSubmission.id, reviewerIdentity, {
      reason: "All deterministic publication gates passed for the fictional fixture.",
      requestId: "req_editorial_publish",
    });
    const [publishedEditorial] = await sql<{ rowCount: number }[]>`
      SELECT count(*)::int AS "rowCount" FROM published_fitments WHERE id = ${prepared.fitmentId}
    `;
    if (publishedEditorial?.rowCount !== 1) throw new Error("Reviewed editorial fitment was not exposed by the published-only view.");

    const [negativeEvidence] = await database
      .insert(schema.fitmentEvidence)
      .values({
        fitmentId: prepared.fitmentId,
        evidenceKind: "community_report",
        outcome: "does_not_fit",
        actorIndependenceKey: "fictional-negative-reporter",
        exactModel: true,
        exactDesignRevision: true,
        summary: "Fictional accepted incompatibility report.",
        observedAt: "2026-07-11",
        moderationStatus: "pending",
      })
      .returning({ id: schema.fitmentEvidence.id });
    if (!negativeEvidence) throw new Error("Negative evidence fixture was not created.");
    const disputed = await moderateEvidence(database, negativeEvidence.id, reviewerIdentity, {
      decision: "accepted",
      reason: "Accepted exact-model incompatibility report opens a dispute.",
      requestId: "req_editorial_dispute",
    });
    if (disputed.confidenceLevel !== "disputed" || disputed.publicationStatus !== "needs_review") {
      throw new Error("Accepted incompatibility evidence did not immediately remove publication eligibility.");
    }
    await archiveFitment(database, prepared.fitmentId, adminIdentity, {
      replacementPath: "/",
      reason: "Archive disputed fictional fitment while retaining evidence and redirect history.",
      requestId: "req_editorial_archive",
    });

    const [rejectedSubmission] = await database
      .insert(schema.submissions)
      .values({
        kind: "design_submission",
        status: "pending",
        payload: {
          sourceUrl: "https://example.invalid/editorial/rejected-latch",
          creatorName: "Fictional rejected creator",
          brand: "DemoVac",
          modelNumber: "DV-100",
          componentName: "Dust-bin latch",
          claimedLicense: "NOT-STATED",
          notes: "Fictional rejection branch.",
          email: "",
          website: "",
        },
      })
      .returning({ id: schema.submissions.id });
    if (!rejectedSubmission) throw new Error("Rejected submission fixture was not created.");
    await prepareCreatorSubmission(database, rejectedSubmission.id, editorIdentity, {
      productComponentId: seedIds.productComponent,
      confirmExactTarget: true,
      designTitle: "Fictional rejected workflow fixture",
      creatorPlatform: "example.invalid",
      sourcePlatform: "example.invalid",
      sourceExternalId: "editorial-rejected-latch",
      sourceRevision: "r1",
      sourceTitle: "Fictional rejected landing page",
      licenseCode: "NOT-STATED",
      licenseVersion: "",
      licenseUrl: "",
      licenseEvidenceUrl: "https://example.invalid/editorial/rejected-latch",
      attributionText: "Fictional rejected latch attribution",
      fileFormats: ["STL"],
      observedAt: "2026-07-11",
      evidenceSummary: "Fictional claim queued for rejection coverage.",
      reason: "Prepare fictional rejection branch.",
      requestId: "req_editorial_reject_prepare",
    });
    const rejected = await reviewCreatorSubmission(database, rejectedSubmission.id, reviewerIdentity, {
      decision: "reject",
      safetyClass: "low",
      safetySignals: ["low_load_clip"],
      safetyRationale: "Fixture value is ignored on rejection.",
      reason: "Reject fictional submission after independent source review.",
      requestId: "req_editorial_reject",
    });
    if (rejected.status !== "rejected") throw new Error("Editorial rejection branch did not finish rejected.");

    const [editorialCounts] = await sql<{ archivedFitments: number; evidenceRows: number; redirects: number; transitions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM fitments WHERE id = ${prepared.fitmentId} AND publication_status = 'archived') AS "archivedFitments",
        (SELECT count(*)::int FROM fitment_evidence WHERE fitment_id = ${prepared.fitmentId}) AS "evidenceRows",
        (SELECT count(*)::int FROM slug_history WHERE entity_id = ${prepared.fitmentId}) AS redirects,
        (SELECT count(*)::int FROM audit_log WHERE action IN ('editorial.case.prepare', 'editorial.case.accept', 'publication.fitment.publish', 'evidence.moderate', 'fitment.archive', 'editorial.case.reject')) AS transitions
    `;
    if (
      editorialCounts?.archivedFitments !== 1 ||
      editorialCounts.evidenceRows !== 2 ||
      editorialCounts.redirects !== 1 ||
      editorialCounts.transitions !== 7
    ) {
      throw new Error(`Editorial workflow evidence is incomplete: ${JSON.stringify(editorialCounts)}.`);
    }

    const [audit] = await sql<{ id: string }[]>`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${staff.id}, 'fixture.review', 'fitment', '00000000-0000-4000-8000-000000000201',
        '{}'::jsonb, '{"status":"reviewed"}'::jsonb, 'Fresh database fixture.', 'req_database_gate')
      RETURNING id
    `;
    if (!audit) throw new Error("Audit fixture was not written.");

    let mutationRejected = false;
    try {
      await sql`DELETE FROM audit_log WHERE id = ${audit.id}`;
    } catch (error) {
      mutationRejected = error instanceof Error && error.message.includes("audit_log is append-only");
    }
    if (!mutationRejected) throw new Error("Audit rows must reject update/delete mutations.");

    const [anonymousPublished] = await sql<{ rowCount: number }[]>`
      SELECT count(*)::int AS "rowCount" FROM published_fitments
    `;
    if (anonymousPublished?.rowCount !== 0) {
      throw new Error("Anonymous published view exposed a fictional draft fitment.");
    }

    console.log("Database checks passed: migrations, seed, idempotent import, exact catalog drafts, independent editorial publish/reject/dispute/archive journeys, published views, staff constraints, and immutable audit are valid.");
  } finally {
    await sql.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
