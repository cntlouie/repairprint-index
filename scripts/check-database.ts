import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { resolveRedirectChain } from "../src/domain/catalogue";
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

    const searchViewRows = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM pg_matviews
      WHERE schemaname = 'public' AND matviewname = 'public_search_documents'
    `;
    if (searchViewRows[0]?.viewCount !== 1) throw new Error("Expected the denormalized public search view.");

    const [catalogueViews] = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('public_catalogue_fitments', 'public_catalogue_unavailable_sources')
    `;
    if (catalogueViews?.viewCount !== 2) throw new Error("Expected both production public catalogue views.");
    const [unsafeUnavailableColumns] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'public_catalogue_unavailable_sources'
        AND column_name IN ('source_url', 'payload', 'email', 'supporting_excerpt')
    `;
    if (unsafeUnavailableColumns?.count !== 0) {
      throw new Error("Unavailable-source tombstones expose a removed URL or private payload column.");
    }

    const extensionRows = await sql<{ extensionCount: number }[]>`
      SELECT count(*)::int AS "extensionCount" FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    const extensionCount = extensionRows[0]?.extensionCount;
    if (extensionCount !== 1) throw new Error("pg_trgm extension was not installed by the migration.");

    await seedDatabase(database);
    await seedDatabase(database);

    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [draftSearchDocuments] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents
    `;
    if (draftSearchDocuments?.count !== 0) {
      throw new Error("Draft models and fitments must not appear in the public search view.");
    }
    const [draftCatalogueDocuments] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments
    `;
    if (draftCatalogueDocuments?.count !== 0) {
      throw new Error("Draft models and fitments must not appear in the production catalogue view.");
    }

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
    const searchDocuments = await sql<{ entityType: string; entityId: string }[]>`
      SELECT entity_type AS "entityType", entity_id AS "entityId"
      FROM public_search_documents
      ORDER BY entity_type, entity_id
    `;
    if (
      searchDocuments.length !== 2 ||
      searchDocuments[0]?.entityType !== "model" ||
      searchDocuments[1]?.entityType !== "part" ||
      searchDocuments[1]?.entityId !== prepared.fitmentId
    ) {
      throw new Error(`Published search view did not expose exactly the eligible model and fitment: ${JSON.stringify(searchDocuments)}.`);
    }
    const [publishedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_catalogue_fitments
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (publishedCatalogue?.count !== 1) {
      throw new Error("Production catalogue did not expose the independently reviewed eligible fitment.");
    }

    const [publishedGraph] = await sql<{
      designId: string;
      revisionId: string;
      sourceId: string;
      componentId: string;
      modelId: string;
      fitmentSlug: string;
    }[]>`
      SELECT
        design_id AS "designId",
        revision_id AS "revisionId",
        source_id AS "sourceId",
        component_id AS "componentId",
        model_id AS "modelId",
        fitment_slug AS "fitmentSlug"
      FROM public_catalogue_fitments
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (!publishedGraph) throw new Error("Published catalogue graph fixture was not found.");

    const [acceptedRevisionCitation] = await sql<{ id: string }[]>`
      SELECT id
      FROM source_citations
      WHERE entity_type = 'design_revision'
        AND entity_id = ${publishedGraph.revisionId}
        AND review_status = 'accepted'
      LIMIT 1
    `;
    if (!acceptedRevisionCitation) throw new Error("Published revision citation fixture was not found.");

    const [secondModel] = await database.insert(schema.productModels).values({
      publicId: "mdl_catalogue_region_b",
      brandId: seedIds.brand,
      categoryId: seedIds.category,
      modelName: "DV/100 Region B",
      slug: "dv-100-region-b",
      marketCodes: ["REGION-B"],
      labelLocation: "Fictional underside label fixture.",
      publicationStatus: "published",
      publishedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.productModels.id });
    if (!secondModel) throw new Error("Second exact-model catalogue fixture was not created.");
    await database.insert(schema.productIdentifiers).values({
      productModelId: secondModel.id,
      displayValue: "DV/100",
      strictKey: "DV/100",
      looseKey: "DV100",
      identifierType: "label",
      marketCode: "REGION-B",
    });
    const [secondProductComponent] = await database.insert(schema.productComponents).values({
      productModelId: secondModel.id,
      componentId: publishedGraph.componentId,
      mappingStatus: "accepted",
    }).returning({ id: schema.productComponents.id });
    if (!secondProductComponent) throw new Error("Second exact-model component fixture was not created.");
    await database.insert(schema.safetyReviews).values({
      productComponentId: secondProductComponent.id,
      safetyClass: "low",
      signals: ["low_load_clip"],
      failureConsequence: "Inconvenience only",
      rationale: "Fictional independently reviewed low-load fixture.",
      rulesetVersion: "safety-v1",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });

    const [secondRevision] = await database.insert(schema.designRevisions).values({
      designId: publishedGraph.designId,
      sourceId: publishedGraph.sourceId,
      sourceRevision: "r2",
      sourceExternalId: "editorial-publishable-latch-r2",
      licenseCode: "NOT-STATED",
      attributionText: "Fictional latch revision two by Fictional workflow creator",
      fileFormats: ["STL"],
      rightsCheckedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.designRevisions.id });
    if (!secondRevision) throw new Error("Second design-revision fixture was not created.");
    const [secondRevisionCitation] = await database.insert(schema.sourceCitations).values({
      sourceId: publishedGraph.sourceId,
      entityType: "design_revision",
      entityId: secondRevision.id,
      fieldPath: "claimed_compatibility",
      claimValue: { fixture: "revision-two" },
      locator: "Explicit WP-07 integration fixture",
      extractionMethod: "editorial",
      reviewStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.sourceCitations.id });
    if (!secondRevisionCitation) throw new Error("Second revision citation fixture was not created.");

    const [secondModelFitment] = await database.insert(schema.fitments).values({
      publicId: "fit_catalogue_region_b_r1",
      slug: "catalogue-region-b-latch-r1",
      designRevisionId: publishedGraph.revisionId,
      productComponentId: secondProductComponent.id,
      confidenceLevel: "verified_fit",
      confidenceScore: 100,
      confidenceVersion: "fitment-v1",
      publicationStatus: "published",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
      lastComputedAt: new Date("2026-07-12T00:00:00Z"),
      publishedAt: new Date("2026-07-13T00:00:00Z"),
    }).returning({ id: schema.fitments.id });
    if (!secondModelFitment) throw new Error("Second exact-model fitment fixture was not created.");
    await database.insert(schema.fitmentEvidence).values({
      fitmentId: secondModelFitment.id,
      evidenceKind: "trusted_physical_test",
      outcome: "fits_without_modification",
      sourceCitationId: acceptedRevisionCitation.id,
      actorIndependenceKey: "wp07-region-b-reviewer",
      exactModel: true,
      exactDesignRevision: true,
      hasInstalledPhoto: true,
      summary: "WP-07_REGION_B_REVISION_ONE_EVIDENCE",
      observedAt: "2026-07-12",
      moderationStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });

    const [secondRevisionFitment] = await database.insert(schema.fitments).values({
      publicId: "fit_catalogue_region_a_r2",
      slug: "catalogue-region-a-latch-r2",
      designRevisionId: secondRevision.id,
      productComponentId: seedIds.productComponent,
      confidenceLevel: "creator_listed",
      confidenceScore: 55,
      confidenceVersion: "fitment-v1",
      publicationStatus: "published",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
      lastComputedAt: new Date("2026-07-12T00:00:00Z"),
      publishedAt: new Date("2026-07-13T00:00:00Z"),
    }).returning({ id: schema.fitments.id });
    if (!secondRevisionFitment) throw new Error("Second design-revision fitment fixture was not created.");
    await database.insert(schema.fitmentEvidence).values({
      fitmentId: secondRevisionFitment.id,
      evidenceKind: "creator_claim",
      outcome: "fits_without_modification",
      sourceCitationId: secondRevisionCitation.id,
      actorIndependenceKey: "wp07-creator-revision-two",
      exactModel: true,
      exactDesignRevision: true,
      summary: "WP-07_REGION_A_REVISION_TWO_EVIDENCE",
      observedAt: "2026-07-12",
      moderationStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });
    await database.insert(schema.printRecipes).values([
      {
        fitmentId: secondModelFitment.id,
        material: "PETG",
        layerHeightMm: 0.2,
        wallCount: 4,
        infillPercent: 35,
        supports: "None",
        orientation: "Broad face down",
        provenance: "editorial",
        sourceCitationId: acceptedRevisionCitation.id,
      },
      {
        fitmentId: secondRevisionFitment.id,
        material: "PETG",
        layerHeightMm: 0.16,
        wallCount: 5,
        infillPercent: 40,
        supports: "Build plate only",
        orientation: "Revision-two documented orientation",
        provenance: "creator_sourced",
        sourceCitationId: secondRevisionCitation.id,
      },
    ]);

    const catalogueEdges = await sql<{
      fitmentId: string;
      modelId: string;
      revisionId: string;
      status: string;
      canonicalSlug: string;
    }[]>`
      SELECT
        fitment_id AS "fitmentId",
        model_id AS "modelId",
        revision_id AS "revisionId",
        fitment_status AS status,
        canonical_slug AS "canonicalSlug"
      FROM public_catalogue_fitments
      WHERE design_id = ${publishedGraph.designId}
        AND component_id = ${publishedGraph.componentId}
      ORDER BY fitment_id
    `;
    if (catalogueEdges.length !== 3) {
      throw new Error(`Expected three independently eligible catalogue edges, found ${JSON.stringify(catalogueEdges)}.`);
    }
    if (catalogueEdges.some((edge) => edge.canonicalSlug !== publishedGraph.fitmentSlug)) {
      throw new Error("Grouped fitment slugs did not converge on one stable canonical part path.");
    }
    const firstModelStatus = catalogueEdges.find((edge) => edge.fitmentId === prepared.fitmentId)?.status;
    const secondModelStatus = catalogueEdges.find((edge) => edge.fitmentId === secondModelFitment.id)?.status;
    if (firstModelStatus !== "creator_listed" || secondModelStatus !== "verified_fit") {
      throw new Error("The same design revision did not retain different fitment labels for different exact models.");
    }
    await sql`UPDATE fitments SET confidence_level = 'candidate_match' WHERE id = ${secondRevisionFitment.id}`;
    const [candidateCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${secondRevisionFitment.id}
    `;
    if (candidateCatalogue?.count !== 0) throw new Error("Candidate fitments must not appear in the production catalogue.");
    await sql`UPDATE fitments SET confidence_level = 'creator_listed' WHERE id = ${secondRevisionFitment.id}`;
    const firstModelEdges = catalogueEdges.filter((edge) => edge.modelId === publishedGraph.modelId);
    if (firstModelEdges.length !== 2 || firstModelEdges.some((edge) => edge.fitmentId === secondModelFitment.id)) {
      throw new Error("Exact-model catalogue filtering leaked a cross-model fitment.");
    }

    const revisionEvidence = await sql<{ revisionId: string; summaries: string[] }[]>`
      SELECT
        catalogue.revision_id AS "revisionId",
        array_agg(evidence.summary ORDER BY evidence.summary) AS summaries
      FROM public_catalogue_fitments AS catalogue
      INNER JOIN fitment_evidence AS evidence ON evidence.fitment_id = catalogue.fitment_id
        AND evidence.moderation_status = 'accepted'
      WHERE catalogue.design_id = ${publishedGraph.designId}
        AND catalogue.model_id = ${publishedGraph.modelId}
      GROUP BY catalogue.revision_id
    `;
    const revisionTwoEvidence = revisionEvidence.find((row) => row.revisionId === secondRevision.id)?.summaries ?? [];
    const revisionOneEvidence = revisionEvidence.find((row) => row.revisionId === publishedGraph.revisionId)?.summaries ?? [];
    if (!revisionTwoEvidence.includes("WP-07_REGION_A_REVISION_TWO_EVIDENCE") || revisionOneEvidence.includes("WP-07_REGION_A_REVISION_TWO_EVIDENCE")) {
      throw new Error("Evidence leaked between separate design revisions.");
    }

    await sql`
      UPDATE submissions
      SET payload = payload || ${sql.json({ email: "private-catalogue@example.invalid", notes: "WP07_PRIVATE_SUBMISSION_SENTINEL" })}::jsonb
      WHERE id = ${creatorSubmission.id}
    `;
    const [privateLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_catalogue_fitments AS catalogue
      WHERE to_jsonb(catalogue)::text LIKE '%WP07_PRIVATE_SUBMISSION_SENTINEL%'
        OR to_jsonb(catalogue)::text LIKE '%private-catalogue@example.invalid%'
    `;
    if (privateLeak?.count !== 0) throw new Error("Private submission payload leaked into a public catalogue response row.");

    await database.insert(schema.sourcePlatformPolicies).values({
      platform: "example",
      policy: "creator_submission",
      termsUrl: "https://example.invalid/fixture-policy",
      termsCheckedAt: new Date("2026-07-12T00:00:00Z"),
      permissionScope: "Test-only demo exclusion fixture.",
      allowedFields: ["fixture"],
    }).onConflictDoNothing();
    await database.insert(schema.sourceCitations).values({
      sourceId: seedIds.source,
      entityType: "design_revision",
      entityId: seedIds.revision,
      fieldPath: "fixture",
      claimValue: { fixture: true },
      extractionMethod: "fixture",
      reviewStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });
    await sql`UPDATE designs SET publication_status = 'published' WHERE id = ${seedIds.design}`;
    await sql`
      UPDATE fitments
      SET publication_status = 'published', reviewed_by = ${reviewerIdentity.id}, reviewed_at = now(), published_at = now()
      WHERE id = ${seedIds.fitment}
    `;
    const [demoLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${seedIds.fitment}
    `;
    if (demoLeak?.count !== 0) throw new Error("A source_type=demo fixture leaked into the production catalogue view.");

    await sql`UPDATE sources SET status = 'removed' WHERE id = ${publishedGraph.sourceId}`;
    await sql`UPDATE designs SET availability_status = 'removed' WHERE id = ${publishedGraph.designId}`;
    const [removedEligible] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE design_id = ${publishedGraph.designId}
    `;
    const [removedTombstones] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_unavailable_sources WHERE design_public_id = (
        SELECT public_id FROM designs WHERE id = ${publishedGraph.designId}
      )
    `;
    if (removedEligible?.count !== 0 || removedTombstones?.count !== 3) {
      throw new Error("Removed source records were not excluded from listings and retained as honest unavailable tombstones.");
    }
    await sql`UPDATE sources SET status = 'live' WHERE id = ${publishedGraph.sourceId}`;
    await sql`UPDATE designs SET availability_status = 'available' WHERE id = ${publishedGraph.designId}`;

    await database.insert(schema.slugHistory).values([
      {
        entityType: "fitment",
        entityId: secondModelFitment.id,
        oldPath: "/parts/wp07-old-slug",
        replacementPath: "/parts/wp07-intermediate-slug",
      },
      {
        entityType: "fitment",
        entityId: secondModelFitment.id,
        oldPath: "/parts/wp07-intermediate-slug",
        replacementPath: `/parts/${publishedGraph.fitmentSlug}`,
      },
    ]);
    const redirectRows = await sql<{ oldPath: string; replacementPath: string }[]>`
      SELECT old_path AS "oldPath", replacement_path AS "replacementPath" FROM slug_history
    `;
    if (resolveRedirectChain(redirectRows, "/parts/wp07-old-slug") !== `/parts/${publishedGraph.fitmentSlug}`) {
      throw new Error("Historical slug did not resolve directly to the final canonical part path.");
    }

    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const canonicalSearchPaths = await sql<{ href: string }[]>`
      SELECT href
      FROM public_search_documents
      WHERE entity_type = 'part'
        AND entity_id IN (${prepared.fitmentId}, ${secondModelFitment.id}, ${secondRevisionFitment.id})
    `;
    if (canonicalSearchPaths.length !== 3 || canonicalSearchPaths.some((row) => row.href !== `/parts/${publishedGraph.fitmentSlug}`)) {
      throw new Error("Search results did not converge grouped fitments on the canonical part page.");
    }

    await sql`UPDATE safety_reviews SET safety_class = 'caution' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [cautionSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (cautionSearch?.count !== 0) throw new Error("Caution-class fitments must not appear in public search.");
    const [cautionCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (cautionCatalogue?.count !== 0) throw new Error("Caution-class fitments must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET safety_class = 'blocked' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [blockedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (blockedSearch?.count !== 0) throw new Error("Blocked fitments must not appear in public search.");
    const [blockedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (blockedCatalogue?.count !== 0) throw new Error("Blocked fitments must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET safety_class = 'low' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`UPDATE fitments SET confidence_version = 'fitment-v0' WHERE id = ${prepared.fitmentId}`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [staleFitmentRulesetSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (staleFitmentRulesetSearch?.count !== 0) throw new Error("Stale fitment-ruleset records must not appear in public search.");
    const [staleFitmentRulesetCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (staleFitmentRulesetCatalogue?.count !== 0) throw new Error("Stale fitment-ruleset records must not appear in the public catalogue.");

    await sql`UPDATE fitments SET confidence_version = 'fitment-v1' WHERE id = ${prepared.fitmentId}`;
    await sql`UPDATE safety_reviews SET ruleset_version = 'safety-v0' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [staleSafetyRulesetSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (staleSafetyRulesetSearch?.count !== 0) throw new Error("Stale safety-ruleset records must not appear in public search.");
    const [staleSafetyRulesetCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (staleSafetyRulesetCatalogue?.count !== 0) throw new Error("Stale safety-ruleset records must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET ruleset_version = 'safety-v1' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v0'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [restoredEligibleSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (restoredEligibleSearch?.count !== 1) throw new Error("Restored eligible fitment did not return to public search.");
    const [restoredEligibleCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (restoredEligibleCatalogue?.count !== 1) throw new Error("Restored eligible fitment did not return to the public catalogue.");

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
    const [disputedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (disputedSearch?.count !== 0) throw new Error("Disputed fitment remained in public search after refresh.");
    const [disputedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (disputedCatalogue?.count !== 0) throw new Error("Disputed fitment remained in the public catalogue.");

    await sql`UPDATE fitment_evidence SET moderation_status = 'rejected' WHERE id = ${negativeEvidence.id}`;
    await sql`
      UPDATE fitments
      SET confidence_level = 'verified_fit', confidence_score = 100, confidence_version = 'fitment-v1', publication_status = 'published'
      WHERE id = ${prepared.fitmentId}
    `;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [restoredBeforeArchive] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (restoredBeforeArchive?.count !== 1) throw new Error("Archive fixture could not restore an eligible search document.");

    await archiveFitment(database, prepared.fitmentId, adminIdentity, {
      replacementPath: "/",
      reason: "Archive disputed fictional fitment while retaining evidence and redirect history.",
      requestId: "req_editorial_archive",
    });
    const [archivedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (archivedSearch?.count !== 0) throw new Error("Archived fitment remained in public search after refresh.");
    const [archivedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (archivedCatalogue?.count !== 0) throw new Error("Archived fitment remained in the public catalogue.");

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

    console.log("Database checks passed: migrations, seed, idempotent import, exact catalog drafts, production search view, independent editorial publish/reject/dispute/archive journeys, published views, staff constraints, and immutable audit are valid.");
  } finally {
    await sql.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
