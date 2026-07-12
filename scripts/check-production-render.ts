import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import * as schema from "../src/db/schema";

const port = 3197;
const origin = `http://127.0.0.1:${port}`;
const submissionServiceRole = "repairprint_submission_service";
const testTurnstileSecret = "1x0000000000000000000000000000000AA";
const privateSentinels = [
  "WP07_PRIVATE_RENDER_SENTINEL",
  "private-render@example.invalid",
  "WP08_MODERATION_ONLY_SENTINEL",
  "WP08_PRIVATE_CONTRIBUTOR_SENTINEL",
  "WP08_PRIVATE_REQUEST_SENTINEL",
  "WP08_PRIVATE_CONTENT_SENTINEL",
  "WP08_PRIVATE_FOLLOW_UP_SENTINEL",
  "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
  "WP08_HTTP_HONEYPOT_SENTINEL",
  "WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
  "WP08_HTTP_RATE_SENTINEL",
  "wp08-http-one@example.invalid",
  "wp08-http-two@example.invalid",
  "wp08-http-evidence@example.invalid",
  "wp08-http-rate@example.invalid",
  "render-editor@example.invalid",
  "render-reviewer@example.invalid",
  "render-admin@example.invalid",
  "render-nonstaff@example.invalid",
  "postgres://",
  "postgresql://",
  "DATABASE_URL",
  "moderation_status",
  "reviewed_by",
  "supporting_excerpt",
  "contact_email",
  "contributor_key",
  "request_fingerprint",
  "content_fingerprint",
  "SUBMISSION_DATABASE_URL",
  "SUBMISSION_HMAC_SECRET",
  "TURNSTILE_SECRET_KEY",
  "submission-render-hmac-secret-at-least-32-bytes",
  testTurnstileSecret,
];
const hostileRedirectDestinations = [
  "/%2F%2Fevil.invalid/x",
  "/%252F%252Fevil.invalid/x",
  "/parts/%2e%2e/admin",
  "/parts/%252e%252e/admin",
  "/parts/foo%5cbar",
  "/parts/foo\\bar",
  "/parts/%2E%2e/admin",
  "/parts/%GG",
  "/parts/canonical-part?next=/admin",
  "/parts/canonical-part#fragment",
  "//evil.invalid/x",
  "https://evil.invalid/x",
] as const;

const ids = {
  reviewer: "70000000-0000-4000-8000-000000000001",
  category: "70000000-0000-4000-8000-000000000002",
  brand: "70000000-0000-4000-8000-000000000003",
  model: "70000000-0000-4000-8000-000000000004",
  primaryIdentifier: "70000000-0000-4000-8000-000000000005",
  uncitedAlias: "70000000-0000-4000-8000-000000000006",
  component: "70000000-0000-4000-8000-000000000007",
  productComponent: "70000000-0000-4000-8000-000000000008",
  creator: "70000000-0000-4000-8000-000000000009",
  liveSource: "70000000-0000-4000-8000-000000000010",
  removedSource: "70000000-0000-4000-8000-000000000011",
  draftSource: "70000000-0000-4000-8000-000000000012",
  liveDesign: "70000000-0000-4000-8000-000000000013",
  removedDesign: "70000000-0000-4000-8000-000000000014",
  draftDesign: "70000000-0000-4000-8000-000000000015",
  liveRevision: "70000000-0000-4000-8000-000000000016",
  removedRevision: "70000000-0000-4000-8000-000000000017",
  draftRevision: "70000000-0000-4000-8000-000000000018",
  identifierCitation: "70000000-0000-4000-8000-000000000019",
  mappingCitation: "70000000-0000-4000-8000-000000000020",
  liveRevisionCitation: "70000000-0000-4000-8000-000000000021",
  removedRevisionCitation: "70000000-0000-4000-8000-000000000022",
  draftRevisionCitation: "70000000-0000-4000-8000-000000000023",
  liveFitment: "70000000-0000-4000-8000-000000000024",
  removedFitment: "70000000-0000-4000-8000-000000000025",
  draftFitment: "70000000-0000-4000-8000-000000000026",
  liveEvidence: "70000000-0000-4000-8000-000000000027",
  removedEvidence: "70000000-0000-4000-8000-000000000028",
  privateSubmission: "70000000-0000-4000-8000-000000000029",
  modelNameCitation: "70000000-0000-4000-8000-000000000030",
  archivedFitment: "70000000-0000-4000-8000-000000000031",
  archivedDestinationFitment: "70000000-0000-4000-8000-000000000032",
  recipe: "70000000-0000-4000-8000-000000000033",
  recipeCitation: "70000000-0000-4000-8000-000000000034",
  archivedRevision: "70000000-0000-4000-8000-000000000035",
  archivedDestinationRevision: "70000000-0000-4000-8000-000000000036",
  privateFollowUp: "70000000-0000-4000-8000-000000000037",
  editorStaff: "70000000-0000-4000-8000-000000000038",
  adminStaff: "70000000-0000-4000-8000-000000000039",
  editorAuth: "70000000-0000-4000-8000-000000000040",
  reviewerAuth: "70000000-0000-4000-8000-000000000041",
  adminAuth: "70000000-0000-4000-8000-000000000042",
  nonstaffAuth: "70000000-0000-4000-8000-000000000043",
} as const;

let databaseSecretSentinels: string[] = [];

type AuthenticationFixture = Readonly<{
  close: () => Promise<void>;
  issueToken: (authUserId: string, email: string, aal: "aal1" | "aal2") => Promise<string>;
  origin: string;
}>;

type StaffSigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (!databaseUrl && process.env.CI !== "true") {
    console.log("Production render check skipped locally: set DATABASE_TEST_URL to the guarded repairprint_test database.");
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_TEST_URL is required for the production render check in CI.");
  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");
  const submissionDatabaseUrl = await provisionSubmissionServiceRole(databaseUrl);
  databaseSecretSentinels = [
    databaseUrl,
    encodeURIComponent(databaseUrl),
    submissionDatabaseUrl,
    encodeURIComponent(submissionDatabaseUrl),
    new URL(submissionDatabaseUrl).password,
  ];
  const authentication = await startAuthenticationFixture();

  try {
    await prepareDatabase(databaseUrl);
    await assertSubmissionServiceBoundary(submissionDatabaseUrl);
    runProductionBuild(databaseUrl, submissionDatabaseUrl, authentication.origin);
    await runHttpAssertions(databaseUrl, submissionDatabaseUrl, authentication);
  } finally {
    await authentication.close();
  }
}

async function prepareDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  const database = drizzle(sql, { schema });
  const now = new Date("2026-07-12T06:00:00Z");

  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.unsafe('CREATE SCHEMA "public"');
    await migrate(database, { migrationsFolder: "drizzle" });

    await database.insert(schema.staffProfiles).values([
      {
        id: ids.editorStaff,
        authUserId: ids.editorAuth,
        email: "render-editor@example.invalid",
        role: "editor",
        status: "active",
      },
      {
        id: ids.reviewer,
        authUserId: ids.reviewerAuth,
        email: "render-reviewer@example.invalid",
        role: "reviewer",
        status: "active",
      },
      {
        id: ids.adminStaff,
        authUserId: ids.adminAuth,
        email: "render-admin@example.invalid",
        role: "admin",
        status: "active",
      },
    ]);

    await database.insert(schema.sourcePlatformPolicies).values({
      platform: "render.example",
      policy: "creator_submission",
      termsUrl: "https://render.example/terms",
      termsCheckedAt: now,
      permissionScope: "Production render integration fixture.",
      allowedFields: ["title", "creator", "model", "component", "print_settings"],
    });
    await database.insert(schema.categories).values({ id: ids.category, name: "Render appliances", slug: "render-appliances" });
    await database.insert(schema.brands).values({
      id: ids.brand,
      name: "RenderWorks",
      slug: "renderworks",
      normalizedName: "renderworks",
      publicationStatus: "published",
    });
    await database.insert(schema.creators).values({
      id: ids.creator,
      displayName: "Render Fixture Creator",
      platform: "render.example",
    });
    await database.insert(schema.sources).values([
      {
        id: ids.liveSource,
        sourceType: "manual",
        platform: "render.example",
        canonicalUrl: "https://render.example/designs/live-latch",
        publisher: "Render Fixture Creator",
        title: "Original RenderWorks latch source",
        retrievedAt: now,
        lastCheckedAt: now,
        status: "live",
      },
      {
        id: ids.removedSource,
        sourceType: "manual",
        platform: "render.example",
        canonicalUrl: "https://render.example/designs/removed-latch",
        publisher: "Render Fixture Creator",
        title: "Removed RenderWorks latch source",
        retrievedAt: now,
        lastCheckedAt: now,
        status: "removed",
      },
      {
        id: ids.draftSource,
        sourceType: "manual",
        platform: "render.example",
        canonicalUrl: "https://render.example/designs/private-draft-latch",
        publisher: "Private Fixture Publisher",
        title: "Private draft source title",
        retrievedAt: now,
        lastCheckedAt: now,
        status: "live",
      },
    ]);

    await database.insert(schema.productModels).values({
      id: ids.model,
      publicId: "mdl_render_rx100",
      brandId: ids.brand,
      categoryId: ids.category,
      modelName: "RX-100",
      slug: "rx-100",
      marketCodes: [],
      labelLocation: null,
      summary: null,
      publicationStatus: "published",
      publishedAt: now,
    });
    await database.insert(schema.productIdentifiers).values([
      {
        id: ids.primaryIdentifier,
        productModelId: ids.model,
        displayValue: "RX-100",
        strictKey: "RX-100",
        looseKey: "RX100",
        identifierType: "model_number",
        sourceCitationId: null,
      },
      {
        id: ids.uncitedAlias,
        productModelId: ids.model,
        displayValue: "WP07_UNCITED_ALIAS_SENTINEL",
        strictKey: "WP07_UNCITED_ALIAS_SENTINEL",
        looseKey: "WP07UNCITEDALIASSENTINEL",
        identifierType: "alias",
        sourceCitationId: null,
      },
    ]);
    await database.insert(schema.components).values({
      id: ids.component,
      categoryId: ids.category,
      name: "Dust-bin latch",
      slug: "dust-bin-latch",
      commonNames: [],
    });
    await database.insert(schema.productComponents).values({
      id: ids.productComponent,
      productModelId: ids.model,
      componentId: ids.component,
      mappingStatus: "accepted",
      sourceCitationId: null,
    });

    await database.insert(schema.designs).values([
      {
        id: ids.liveDesign,
        publicId: "des_render_live_latch",
        slug: "render-live-latch",
        creatorId: ids.creator,
        title: "RenderWorks RX-100 latch",
        publicationStatus: "published",
        availabilityStatus: "available",
      },
      {
        id: ids.removedDesign,
        publicId: "des_render_removed_latch",
        slug: "render-removed-latch",
        creatorId: ids.creator,
        title: "Removed RenderWorks latch",
        publicationStatus: "published",
        availabilityStatus: "removed",
      },
      {
        id: ids.draftDesign,
        publicId: "des_render_private_latch",
        slug: "render-private-latch",
        creatorId: ids.creator,
        title: "WP07_PRIVATE_DESIGN_SENTINEL",
        publicationStatus: "draft",
        availabilityStatus: "available",
      },
    ]);
    await database.insert(schema.designRevisions).values([
      {
        id: ids.liveRevision,
        designId: ids.liveDesign,
        sourceId: ids.liveSource,
        sourceRevision: "r1",
        sourceExternalId: "render-live-r1",
        licenseCode: "CC-BY-4.0",
        licenseVersion: "4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        licenseEvidenceUrl: "https://render.example/designs/live-latch",
        attributionText: "Render Fixture Creator",
        fileFormats: ["STL"],
        rightsCheckedAt: now,
        rightsCheckedBy: ids.reviewer,
      },
      {
        id: ids.removedRevision,
        designId: ids.removedDesign,
        sourceId: ids.removedSource,
        sourceRevision: "r1",
        sourceExternalId: "render-removed-r1",
        licenseCode: "CC-BY-4.0",
        licenseVersion: "4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        licenseEvidenceUrl: "https://render.example/designs/removed-latch",
        attributionText: "Render Fixture Creator",
        fileFormats: ["STL"],
        rightsCheckedAt: now,
        rightsCheckedBy: ids.reviewer,
      },
      {
        id: ids.draftRevision,
        designId: ids.draftDesign,
        sourceId: ids.draftSource,
        sourceRevision: "private-r1",
        sourceExternalId: "private-render-r1",
        licenseCode: "NOT-STATED",
        attributionText: "Private fixture attribution",
        fileFormats: ["STL"],
        rightsCheckedAt: now,
        rightsCheckedBy: ids.reviewer,
      },
      {
        id: ids.archivedRevision,
        designId: ids.liveDesign,
        sourceId: ids.liveSource,
        sourceRevision: "r0",
        sourceExternalId: "render-archived-r0",
        licenseCode: "CC-BY-4.0",
        licenseVersion: "4.0",
        attributionText: "Render Fixture Creator",
        fileFormats: ["STL"],
        rightsCheckedAt: now,
        rightsCheckedBy: ids.reviewer,
      },
      {
        id: ids.archivedDestinationRevision,
        designId: ids.liveDesign,
        sourceId: ids.liveSource,
        sourceRevision: "r-1",
        sourceExternalId: "render-archived-destination-r0",
        licenseCode: "CC-BY-4.0",
        licenseVersion: "4.0",
        attributionText: "Render Fixture Creator",
        fileFormats: ["STL"],
        rightsCheckedAt: now,
        rightsCheckedBy: ids.reviewer,
      },
    ]);

    await database.insert(schema.sourceCitations).values([
      acceptedCitation(ids.identifierCitation, ids.liveSource, "product_identifier", ids.primaryIdentifier, "display_value", { displayValue: "RX-100" }, now),
      acceptedCitation(ids.modelNameCitation, ids.liveSource, "product_model", ids.model, "model_name", { modelName: "RX-100" }, now),
      acceptedCitation(ids.mappingCitation, ids.liveSource, "product_component", ids.productComponent, "mapping", { model: "RX-100", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.liveRevisionCitation, ids.liveSource, "design_revision", ids.liveRevision, "claimed_compatibility", { model: "RX-100", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.removedRevisionCitation, ids.removedSource, "design_revision", ids.removedRevision, "claimed_compatibility", { model: "RX-100", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.draftRevisionCitation, ids.draftSource, "design_revision", ids.draftRevision, "claimed_compatibility", { private: true }, now),
      acceptedCitation(ids.recipeCitation, ids.liveSource, "print_recipe", ids.recipe, "settings", { material: "PETG", nozzleMm: 0.4 }, now),
    ]);
    await sql`UPDATE product_identifiers SET source_citation_id = ${ids.identifierCitation} WHERE id = ${ids.primaryIdentifier}`;
    await sql`UPDATE product_components SET source_citation_id = ${ids.mappingCitation} WHERE id = ${ids.productComponent}`;

    await database.insert(schema.safetyReviews).values({
      productComponentId: ids.productComponent,
      safetyClass: "low",
      signals: ["low_load_clip"],
      failureConsequence: "Inconvenience only",
      rationale: "Independently reviewed low-load external latch.",
      rulesetVersion: "safety-v1",
      reviewedBy: ids.reviewer,
      reviewedAt: now,
    });
    await database.insert(schema.fitments).values([
      {
        id: ids.liveFitment,
        publicId: "fit_render_live_r1",
        slug: "render-rx100-latch-r1",
        designRevisionId: ids.liveRevision,
        productComponentId: ids.productComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "published",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: now,
      },
      {
        id: ids.removedFitment,
        publicId: "fit_render_removed_r1",
        slug: "render-removed-latch-r1",
        designRevisionId: ids.removedRevision,
        productComponentId: ids.productComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "published",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: new Date("2026-07-12T06:01:00Z"),
      },
      {
        id: ids.draftFitment,
        publicId: "fit_render_private_r1",
        slug: "render-private-latch-r1",
        designRevisionId: ids.draftRevision,
        productComponentId: ids.productComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "draft",
      },
      {
        id: ids.archivedFitment,
        publicId: "fit_render_archived_canonical_r0",
        slug: "render-archived-canonical-r0",
        designRevisionId: ids.archivedRevision,
        productComponentId: ids.productComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "archived",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: new Date("2026-07-12T05:59:00Z"),
      },
      {
        id: ids.archivedDestinationFitment,
        publicId: "fit_render_archived_destination_r0",
        slug: "render-archived-ineligible-r0",
        designRevisionId: ids.archivedDestinationRevision,
        productComponentId: ids.productComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "archived",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: new Date("2026-07-12T05:58:00Z"),
      },
    ]);
    await database.insert(schema.fitmentEvidence).values([
      {
        id: ids.liveEvidence,
        fitmentId: ids.liveFitment,
        evidenceKind: "creator_claim",
        outcome: "fits_without_modification",
        sourceCitationId: ids.liveRevisionCitation,
        actorIndependenceKey: "render-creator-live",
        exactModel: true,
        exactDesignRevision: true,
        summary: "Creator cites the exact RX-100 and r1 design revision.",
        observedAt: "2026-07-12",
        moderationStatus: "accepted",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      },
      {
        id: ids.removedEvidence,
        fitmentId: ids.removedFitment,
        evidenceKind: "creator_claim",
        outcome: "fits_without_modification",
        sourceCitationId: ids.removedRevisionCitation,
        actorIndependenceKey: "render-creator-removed",
        exactModel: true,
        exactDesignRevision: true,
        summary: "Previously accepted removed-source fixture.",
        observedAt: "2026-07-12",
        moderationStatus: "accepted",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      },
    ]);
    await database.insert(schema.printRecipes).values({
      id: ids.recipe,
      fitmentId: ids.liveFitment,
      material: "PETG",
      nozzleMm: 0.4,
      layerHeightMm: 0.2,
      wallCount: 4,
      infillPercent: 35,
      supports: "None",
      orientation: "Broad face down",
      provenance: "creator_sourced",
      sourceCitationId: ids.recipeCitation,
    });
    await database.insert(schema.submissions).values({
      id: ids.privateSubmission,
      kind: "design_submission",
      status: "resolved",
      intakeVersion: 1,
      idempotencyKeyHash: "WP08_PRIVATE_IDEMPOTENCY_SENTINEL",
      requestFingerprint: "WP08_PRIVATE_REQUEST_SENTINEL",
      contributorKey: "WP08_PRIVATE_CONTRIBUTOR_SENTINEL",
      contentFingerprint: "WP08_PRIVATE_CONTENT_SENTINEL",
      contributorTermsVersion: "wp08-operating-draft-v1",
      privacyNoticeVersion: "wp08-operating-draft-v1",
      consentedAt: now,
      challengeProvider: "turnstile",
      challengeVerifiedAt: now,
      contactEmail: "private-render@example.invalid",
      contactConsentVersion: "wp08-email-follow-up-v1",
      contactConsentedAt: now,
      contactRetentionExpiresAt: new Date("2026-08-12T06:00:00Z"),
      retentionExpiresAt: new Date("2026-10-12T06:00:00Z"),
      retentionPolicyVersion: "wp08-render-retention-v1",
      matchedEntityType: "design",
      matchedEntityId: ids.liveDesign,
      payload: {
        notes: "WP07_PRIVATE_RENDER_SENTINEL",
        moderationNotes: "WP08_MODERATION_ONLY_SENTINEL",
      },
      reviewedBy: ids.reviewer,
      reviewedAt: now,
      resolvedAt: now,
    });
    await database.insert(schema.submissionEmailFollowUps).values({
      id: ids.privateFollowUp,
      availableAt: now,
      followUpKey: "WP08_PRIVATE_FOLLOW_UP_SENTINEL",
      qualifyingEvent: "moderator_question",
      submissionId: ids.privateSubmission,
      templateKey: "moderator-follow-up",
    });
    await database.insert(schema.slugHistory).values([
      {
        entityType: "fitment",
        entityId: ids.liveFitment,
        oldPath: "/parts/render-historical-latch",
        replacementPath: "/parts/render-rx100-latch-r1",
      },
      {
        entityType: "fitment",
        entityId: ids.draftFitment,
        oldPath: "/parts/render-private-history",
        replacementPath: "/parts/render-private-latch-r1",
      },
      {
        entityType: "fitment",
        entityId: ids.archivedFitment,
        oldPath: "/parts/render-archived-canonical-r0",
        replacementPath: "/parts/render-rx100-latch-r1",
      },
      {
        entityType: "fitment",
        entityId: ids.archivedDestinationFitment,
        oldPath: "/parts/render-archived-destination-history",
        replacementPath: "/parts/render-archived-ineligible-r0",
      },
      {
        entityType: "fitment",
        entityId: ids.removedFitment,
        oldPath: "/parts/render-removed-history",
        replacementPath: "/parts/render-removed-latch-r1",
      },
      ...hostileRedirectDestinations.map((replacementPath, index) => ({
        entityType: "fitment" as const,
        entityId: ids.liveFitment,
        oldPath: `/parts/render-hostile-${String(index + 1).padStart(2, "0")}`,
        replacementPath,
      })),
    ]);
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
  } finally {
    await sql.end();
  }
}

async function provisionSubmissionServiceRole(databaseUrl: string): Promise<string> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const password = `rp_${randomBytes(24).toString("hex")}`;

  try {
    const [existing] = await owner<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${submissionServiceRole}) AS exists
    `;
    if (existing?.exists) {
      await owner.unsafe(`ALTER ROLE ${submissionServiceRole} WITH LOGIN PASSWORD '${password}'`);
    } else {
      await owner.unsafe(`CREATE ROLE ${submissionServiceRole} LOGIN PASSWORD '${password}'`);
    }
  } finally {
    await owner.end();
  }

  const serviceUrl = new URL(databaseUrl);
  serviceUrl.username = submissionServiceRole;
  serviceUrl.password = password;
  return serviceUrl.toString();
}

async function assertSubmissionServiceBoundary(submissionDatabaseUrl: string): Promise<void> {
  const service = postgres(submissionDatabaseUrl, { prepare: false, max: 1 });
  try {
    const [boundary] = await service<{
      currentUser: string;
      schemaUsage: boolean;
      submissionsRead: boolean;
      submissionsDelete: boolean;
      rateLimitsRead: boolean;
      rateLimitsDelete: boolean;
      followUpsRead: boolean;
      followUpsDelete: boolean;
      broadWritePrivileges: number;
      columnWritePrivileges: number;
      staffRead: boolean;
      creatorsRead: boolean;
      catalogueRead: boolean;
      searchRead: boolean;
      roleElevated: boolean;
    }[]>`
      SELECT
        current_user AS "currentUser",
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
          FROM pg_roles WHERE rolname = current_user) AS "roleElevated",
        has_schema_privilege(current_user, 'public', 'USAGE') AS "schemaUsage",
        has_table_privilege(current_user, 'public.submissions', 'SELECT') AS "submissionsRead",
        has_table_privilege(current_user, 'public.submissions', 'DELETE') AS "submissionsDelete",
        has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'SELECT') AS "rateLimitsRead",
        has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'DELETE') AS "rateLimitsDelete",
        has_table_privilege(current_user, 'public.submission_email_follow_ups', 'SELECT') AS "followUpsRead",
        has_table_privilege(current_user, 'public.submission_email_follow_ups', 'DELETE') AS "followUpsDelete",
        (SELECT count(*)::int FROM information_schema.table_privileges
          WHERE grantee = current_user AND table_schema = 'public'
            AND privilege_type IN ('INSERT', 'UPDATE')) AS "broadWritePrivileges",
        (SELECT count(*)::int FROM information_schema.column_privileges
          WHERE grantee = current_user AND table_schema = 'public'
            AND privilege_type IN ('INSERT', 'UPDATE')) AS "columnWritePrivileges",
        has_table_privilege(current_user, 'public.staff_profiles', 'SELECT') AS "staffRead",
        has_table_privilege(current_user, 'public.creators', 'SELECT') AS "creatorsRead",
        has_table_privilege(current_user, 'public.public_catalogue_fitments', 'SELECT') AS "catalogueRead",
        has_table_privilege(current_user, 'public.public_search_documents', 'SELECT') AS "searchRead"
    `;
    if (
      !boundary
      || boundary.currentUser !== submissionServiceRole
      || !boundary.schemaUsage
      || !boundary.submissionsRead
      || !boundary.submissionsDelete
      || !boundary.rateLimitsRead
      || !boundary.rateLimitsDelete
      || !boundary.followUpsRead
      || !boundary.followUpsDelete
      || boundary.broadWritePrivileges !== 0
      || boundary.columnWritePrivileges !== 37
      || boundary.roleElevated
    ) {
      throw new Error(`Submission service role lacks its exact private-queue allowlist: ${JSON.stringify(boundary)}.`);
    }
    if (boundary.staffRead || boundary.creatorsRead || boundary.catalogueRead || boundary.searchRead) {
      throw new Error(`Submission service role can read outside its private-queue allowlist: ${JSON.stringify(boundary)}.`);
    }

    let unrelatedReadDenied = false;
    try {
      await service`SELECT count(*) FROM creators`;
    } catch (error) {
      unrelatedReadDenied = databaseErrorCode(error) === "42501";
    }
    if (!unrelatedReadDenied) throw new Error("Submission service role could read an unrelated catalogue base table.");
  } finally {
    await service.end();
  }
}

async function startAuthenticationFixture(): Promise<AuthenticationFixture> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const keyId = `wp08-${randomUUID()}`;
  const publicJwk = await exportJWK(publicKey);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/auth/v1/.well-known/jwks.json") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }] }));
  });
  await listenOnLoopback(server);
  const address = server.address() as AddressInfo;
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;

  return Object.freeze({
    close: () => closeServer(server),
    origin: fixtureOrigin,
    issueToken: (authUserId, email, aal) => issueStaffToken(
      privateKey,
      keyId,
      fixtureOrigin,
      authUserId,
      email,
      aal,
    ),
  });
}

async function issueStaffToken(
  privateKey: StaffSigningKey,
  keyId: string,
  issuerOrigin: string,
  authUserId: string,
  email: string,
  aal: "aal1" | "aal2",
): Promise<string> {
  return new SignJWT({ aal, email, is_anonymous: false, role: "authenticated" })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setSubject(authUserId)
    .setIssuer(`${issuerOrigin}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return databaseErrorCode(error.cause);
  return undefined;
}

function acceptedCitation(
  id: string,
  sourceId: string,
  entityType: string,
  entityId: string,
  fieldPath: string,
  claimValue: Record<string, unknown>,
  reviewedAt: Date,
): typeof schema.sourceCitations.$inferInsert {
  return {
    id,
    sourceId,
    entityType,
    entityId,
    fieldPath,
    claimValue,
    locator: "Production render integration fixture",
    supportingExcerpt: "Reviewed fictional fixture evidence.",
    extractionMethod: "editorial",
    reviewStatus: "accepted",
    reviewedBy: ids.reviewer,
    reviewedAt,
  };
}

function runProductionBuild(databaseUrl: string, submissionDatabaseUrl: string, authenticationOrigin: string): void {
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("Production-mode Next.js build failed during render integration.");
  }
  assertClientBundleSafe();
}

async function runHttpAssertions(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authentication: AuthenticationFixture,
): Promise<void> {
  const turnstileNonce = randomBytes(24).toString("hex");
  const preload = pathToFileURL(path.join(process.cwd(), "scripts", "turnstile-integration-preload.mjs")).href;
  const baseEnvironment = productionEnvironment(databaseUrl, submissionDatabaseUrl, authentication.origin);
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...baseEnvironment,
      CI: "true",
      NODE_OPTIONS: [baseEnvironment.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" "),
      REPAIRPRINT_HTTP_TEST_NONCE: turnstileNonce,
      VERCEL: "1",
      VERCEL_ENV: "integration-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  server.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitForServer(server, () => output);

    const firstContributionForm = await request("/request-part", 200);
    const secondContributionForm = await request("/request-part", 200);
    const firstIdempotencyKey = firstContributionForm.body.match(/name="idempotencyKey"[^>]*value="([^"]+)"/)?.[1];
    const secondIdempotencyKey = secondContributionForm.body.match(/name="idempotencyKey"[^>]*value="([^"]+)"/)?.[1];
    if (!firstIdempotencyKey || !secondIdempotencyKey || firstIdempotencyKey === secondIdempotencyKey) {
      throw new Error("Production contribution forms reused a prerendered idempotency key.");
    }
    for (const expected of [
      "/api/v1/submissions/requests",
      "privacyConsent",
      "contributionConsent",
      "emailFollowUpConsent",
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      "noindex",
    ]) assertIncludes(firstContributionForm.body, expected, `protected contribution form: ${expected}`);
    assertExcludes(firstContributionForm.body, 'type="file"', "WP-08 contribution form");
    assertPrivateDataAbsent(firstContributionForm.body, "WP-08 contribution form HTML/flight");
    for (const path of ["/confirm-fit", "/submit-design", "/contribution-privacy"] as const) {
      const contributionPage = await request(path, 200);
      assertPrivateDataAbsent(contributionPage.body, `${path} HTML/flight`);
      assertIncludes(contributionPage.body, "noindex", `${path} robots metadata`);
    }

    const missingIdempotencyKey = randomUUID();
    const missingRequest = {
      brand: "WP08 HTTP fixture",
      brokenPart: "Dust-bin latch",
      contributionConsent: true,
      email: "wp08-http-one@example.invalid",
      emailFollowUpConsent: true,
      idempotencyKey: missingIdempotencyKey,
      modelNumber: "HTTP-100",
      notes: "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
      oemPartNumber: "HTTP-OEM-1",
      privacyConsent: true,
      website: "",
    };
    const firstMissingReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      { ...missingRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
      "203.0.113.42",
      202,
    ), "missing-part HTTP intake");
    const retriedMissingReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      { ...missingRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
      "203.0.113.42",
      202,
    ), "idempotent missing-part HTTP retry");
    if (retriedMissingReceipt !== firstMissingReceipt) {
      throw new Error("An idempotent HTTP retry did not return its original opaque receipt.");
    }
    const secondContributorReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...missingRequest,
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
        email: "wp08-http-two@example.invalid",
        idempotencyKey: missingIdempotencyKey,
      },
      "203.0.113.43",
      202,
    ), "independent missing-part HTTP intake");
    if (secondContributorReceipt === firstMissingReceipt) {
      throw new Error("Two contributors reusing one client UUID received the same opaque receipt.");
    }
    await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...missingRequest,
        brand: "WP08_HTTP_HONEYPOT_SENTINEL",
        challengeToken: "not-a-valid-token",
        email: "",
        emailFollowUpConsent: false,
        idempotencyKey: randomUUID(),
        website: "https://spam.invalid",
      },
      "203.0.113.44",
      202,
    ), "opaque honeypot HTTP intake");

    const designResponse = await postSubmission(
      "/api/v1/submissions/designs",
      {
        brand: "WP08 HTTP fixture",
        challengeToken: integrationToken(turnstileNonce, "design_submission"),
        claimedLicense: "NOT-STATED",
        componentName: "Dust-bin latch",
        contributionConsent: true,
        creatorName: "HTTP Fixture Creator",
        idempotencyKey: randomUUID(),
        modelNumber: "HTTP-100",
        notes: "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
        privacyConsent: true,
        sourceUrl: "https://example.invalid/wp08-http-design",
        website: "",
      },
      "203.0.113.45",
      303,
      "form",
    );
    const designLocation = designResponse.headers.get("location");
    if (!designLocation || new URL(designLocation, origin).pathname !== "/submit-design"
      || new URL(designLocation, origin).searchParams.get("submitted") !== "1") {
      throw new Error(`Design form did not redirect to its fixed confirmation path: ${designLocation ?? "missing"}.`);
    }

    const fitToken = integrationToken(turnstileNonce, "fit_confirmation");
    await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      {
        challengeToken: fitToken,
        contributionConsent: true,
        designRevision: "r-http",
        email: "wp08-http-evidence@example.invalid",
        emailFollowUpConsent: true,
        evidenceUrl: "https://example.invalid/private-fit?token=WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
        idempotencyKey: randomUUID(),
        modelNumber: "HTTP-100",
        modificationNotes: "Printer stopped before fit could be tested.",
        outcome: "print_failed",
        partSlug: "wp08-http-latch",
        printSettings: "PETG",
        privacyConsent: true,
        website: "",
      },
      "203.0.113.46",
      202,
    ), "print-failed HTTP intake");
    const replay = await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      {
        challengeToken: fitToken,
        contributionConsent: true,
        designRevision: "r-http",
        idempotencyKey: randomUUID(),
        modelNumber: "HTTP-100",
        outcome: "does_not_fit",
        partSlug: "wp08-http-latch",
        privacyConsent: true,
        website: "",
      },
      "203.0.113.46",
      400,
    );
    assertIncludes(replay.body, "HUMAN_VERIFICATION_FAILED", "single-use Turnstile HTTP replay");
    await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      {
        challengeToken: integrationToken(turnstileNonce, "fit_confirmation"),
        contributionConsent: true,
        designRevision: "r-http",
        idempotencyKey: randomUUID(),
        modelNumber: "HTTP-100",
        modificationNotes: "Exact model and revision did not fit.",
        outcome: "does_not_fit",
        partSlug: "wp08-http-latch",
        printSettings: "PETG",
        privacyConsent: true,
        website: "",
      },
      "203.0.113.47",
      202,
    ), "does-not-fit HTTP intake");

    await enterStableRateWindow();
    const rateLimitRequest = {
      brand: "WP08 HTTP rate fixture",
      brokenPart: "Rate-limited latch",
      contributionConsent: true,
      email: "wp08-http-rate@example.invalid",
      emailFollowUpConsent: true,
      modelNumber: "RATE-100",
      notes: "WP08_HTTP_RATE_SENTINEL",
      privacyConsent: true,
      website: "",
    };
    let rateReceipt: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const receipt = await assertAcceptedJson(await postSubmission(
        "/api/v1/submissions/requests",
        {
          ...rateLimitRequest,
          challengeToken: integrationToken(turnstileNonce, "missing_part"),
          idempotencyKey: randomUUID(),
        },
        "203.0.113.48",
        202,
      ), `endpoint rate-limit accepted request ${attempt + 1}`);
      if (rateReceipt !== undefined && receipt !== rateReceipt) {
        throw new Error("Endpoint rate-limit fixture did not deduplicate repeated contributor content.");
      }
      rateReceipt = receipt;
    }
    const endpointLimited = await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...rateLimitRequest,
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
        idempotencyKey: randomUUID(),
      },
      "203.0.113.48",
      429,
    );
    assertRateLimited(endpointLimited, "endpoint HTTP rate limit");

    const globalHoneypotRequest = {
      ...missingRequest,
      brand: "WP08_HTTP_HONEYPOT_SENTINEL",
      challengeToken: "not-a-valid-token",
      email: "",
      emailFollowUpConsent: false,
      website: "https://spam.invalid",
    };
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await assertAcceptedJson(await postSubmission(
        "/api/v1/submissions/requests",
        { ...globalHoneypotRequest, idempotencyKey: randomUUID() },
        "203.0.113.49",
        202,
      ), `global rate-limit honeypot request ${attempt + 1}`);
    }
    const globalLimited = await postSubmission(
      "/api/v1/submissions/requests",
      { ...globalHoneypotRequest, idempotencyKey: randomUUID() },
      "203.0.113.49",
      429,
    );
    assertRateLimited(globalLimited, "global HTTP rate limit");

    const submissionIds = await assertHttpSubmissionPersistence(databaseUrl);
    await assertPrivateEvidenceAuthorization(submissionIds, authentication);

    const model = await request("/brands/renderworks/rx-100", 200);
    assertIncludes(model.body, "RenderWorks RX-100 printable repair parts", "exact-model metadata title");
    assertIncludes(model.body, "RX-100", "accepted primary identifier");
    assertIncludes(model.body, "/brands/renderworks/rx-100", "exact-model canonical metadata");
    assertIncludes(model.body, "/parts/render-rx100-latch-r1", "eligible exact-model part link");
    assertExcludes(model.body, "WP07_UNCITED_ALIAS_SENTINEL", "uncited identifier in model HTML/flight");
    assertPrivateDataAbsent(model.body, "exact-model HTML/flight");

    const part = await request("/parts/render-rx100-latch-r1", 200);
    for (const expected of [
      "Dust-bin latch printable replacement",
      "RenderWorks RX-100 latch",
      "RenderWorks RX-100",
      "Creator listed",
      "CC-BY-4.0",
      "Creator cites the exact RX-100 and r1 design revision.",
      "PETG",
      "Low-risk v0 boundary",
      "https://render.example/designs/live-latch",
    ]) assertIncludes(part.body, expected, `canonical part content: ${expected}`);
    assertIncludes(part.body, "<dt>Revision</dt><dd>r1</dd>", "canonical part exact revision field");
    assertPrivateDataAbsent(part.body, "canonical part HTML/flight");

    const directFlight = await fetch(`${origin}/parts/render-rx100-latch-r1?_rsc=wp07`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    if (directFlight.status !== 200) throw new Error(`Direct React server payload returned ${directFlight.status}.`);
    const flightBody = await directFlight.text();
    if (!directFlight.headers.get("content-type")?.includes("text/x-component")) {
      throw new Error(`Expected a React server payload, received ${directFlight.headers.get("content-type") ?? "no content type"}.`);
    }
    assertIncludes(flightBody, "RenderWorks RX-100", "direct React server payload");
    assertPrivateDataAbsent(flightBody, "direct React server payload");

    const tombstone = await request("/parts/render-removed-latch-r1", 200);
    assertIncludes(tombstone.body, "Source unavailable", "removed-source heading");
    assertIncludes(tombstone.body, "noindex", "removed-source robots metadata");
    assertExcludes(tombstone.body, "https://render.example/designs/removed-latch", "removed source URL");
    assertExcludes(tombstone.body, "Open original source", "removed source action");
    assertPrivateDataAbsent(tombstone.body, "removed-source HTML/flight");

    const historical = await request("/parts/render-historical-latch", 308);
    if (historical.location !== "/parts/render-rx100-latch-r1") {
      throw new Error(`Historical slug redirected to ${historical.location ?? "no location"}.`);
    }
    const archivedCanonical = await request("/parts/render-archived-canonical-r0", 308);
    if (archivedCanonical.location !== "/parts/render-rx100-latch-r1") {
      throw new Error(`Archived canonical slug redirected to ${archivedCanonical.location ?? "no location"}.`);
    }
    const tombstoneHistory = await request("/parts/render-removed-history", 308);
    if (tombstoneHistory.location !== "/parts/render-removed-latch-r1") {
      throw new Error(`Safe tombstone history redirected to ${tombstoneHistory.location ?? "no location"}.`);
    }
    await assertNotFound("/parts/render-private-history");
    await assertNotFound("/parts/render-private-latch-r1");
    await assertNotFound("/parts/render-archived-destination-history");
    await assertNotFound("/parts/render-archived-ineligible-r0");
    for (let index = 0; index < hostileRedirectDestinations.length; index += 1) {
      await assertNotFound(`/parts/render-hostile-${String(index + 1).padStart(2, "0")}`);
    }
    await assertNotFound("/parts/unknown-render-fitment");
    await assertNotFound("/brands/demovac/dv-100");

    console.log("Production render checks passed: production HTTP submissions, staff authorization, model, canonical part, metadata, React payload, tombstone, redirect, 404, and privacy boundaries are valid.");
  } finally {
    await stopServer(server);
    assertPrivateDataAbsent(output, "production Next.js process output");
  }
}

function productionEnvironment(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DEMO_MODE: "false",
    NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: origin,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    NEXT_TELEMETRY_DISABLED: "1",
    SUBMISSION_CONTACT_RETENTION_DAYS: "30",
    SUBMISSION_DATABASE_URL: submissionDatabaseUrl,
    SUBMISSION_HMAC_SECRET: "submission-render-hmac-secret-at-least-32-bytes",
    SUBMISSION_RETENTION_DAYS: "90",
    SUBMISSION_RETENTION_POLICY_VERSION: "wp08-render-retention-v1",
    SUPABASE_URL: authenticationOrigin,
    TURNSTILE_SECRET_KEY: testTurnstileSecret,
  };
}

type HttpResponse = Readonly<{
  body: string;
  headers: Headers;
  status: number;
}>;

async function postSubmission(
  pathname: string,
  payload: Record<string, unknown>,
  clientIp: string,
  expectedStatus: number,
  encoding: "json" | "form" = "json",
): Promise<HttpResponse> {
  const headers = new Headers({
    Accept: encoding === "form" ? "text/html" : "application/json",
    "Content-Type": encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
    Origin: origin,
    "X-Vercel-Forwarded-For": clientIp,
  });
  const body = encoding === "form"
    ? new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString()
    : JSON.stringify(payload);
  const response = await fetch(`${origin}${pathname}`, {
    body,
    headers,
    method: "POST",
    redirect: "manual",
  });
  const responseBody = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${pathname} returned ${response.status}, expected ${expectedStatus}. Body: ${responseBody.slice(0, 500)}`);
  }
  assertPrivateResponseHeaders(response.headers, pathname);
  if (expectedStatus !== 200) assertPrivateDataAbsent(responseBody, `${pathname} HTTP response`);
  return Object.freeze({ body: responseBody, headers: response.headers, status: response.status });
}

async function assertAcceptedJson(response: HttpResponse, label: string): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
  if (!body || typeof body !== "object") throw new Error(`${label} returned a non-object receipt.`);
  const record = body as Record<string, unknown>;
  if (record.status !== "pending" || typeof record.id !== "string" || !/^[0-9a-f-]{36}$/.test(record.id)) {
    throw new Error(`${label} exposed an invalid or non-opaque receipt: ${response.body}.`);
  }
  if (Object.keys(record).sort().join(",") !== "id,status") {
    throw new Error(`${label} exposed fields beyond the opaque receipt: ${response.body}.`);
  }
  return record.id;
}

function assertRateLimited(response: HttpResponse, label: string): void {
  assertIncludes(response.body, "RATE_LIMITED", label);
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter || !/^\d+$/.test(retryAfter) || Number(retryAfter) < 1) {
    throw new Error(`${label} omitted a positive integer Retry-After header.`);
  }
}

function assertPrivateResponseHeaders(headers: Headers, label: string): void {
  if (!headers.get("cache-control")?.includes("no-store")) throw new Error(`${label} omitted private no-store caching.`);
  if (headers.get("x-robots-tag") !== "noindex, nofollow, noarchive") {
    throw new Error(`${label} omitted the private noindex response boundary.`);
  }
}

function integrationToken(nonce: string, action: "missing_part" | "fit_confirmation" | "design_submission"): string {
  return `wp08.${nonce}.${action}.${randomUUID()}`;
}

async function enterStableRateWindow(): Promise<void> {
  const windowMilliseconds = 10 * 60 * 1000;
  const minimumRemainingMilliseconds = 30 * 1000;
  const remaining = windowMilliseconds - (Date.now() % windowMilliseconds);
  if (remaining < minimumRemainingMilliseconds) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 100));
  }
}

async function assertHttpSubmissionPersistence(databaseUrl: string): Promise<Readonly<{
  evidenceSubmissionId: string;
  nonEvidenceSubmissionId: string;
}>> {
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const rows = await sql<{
      contactEmail: string | null;
      contentFingerprint: string;
      contributorKey: string;
      id: string;
      idempotencyKeyHash: string;
      kind: string;
      payload: Record<string, unknown>;
      status: string;
    }[]>`
      SELECT
        id,
        kind,
        status,
        payload,
        contact_email AS "contactEmail",
        content_fingerprint AS "contentFingerprint",
        contributor_key AS "contributorKey",
        idempotency_key_hash AS "idempotencyKeyHash"
      FROM submissions
      WHERE intake_version = 1 AND payload->>'modelNumber' = 'HTTP-100'
      ORDER BY created_at, id
    `;
    const missing = rows.filter((row) => row.kind === "missing_part");
    const designs = rows.filter((row) => row.kind === "design_submission");
    const fitReports = rows.filter((row) => row.kind === "fit_confirmation");
    if (rows.length !== 5 || missing.length !== 2 || designs.length !== 1 || fitReports.length !== 2) {
      throw new Error(`Production HTTP endpoints persisted an unexpected private queue: ${JSON.stringify(rows.map(({ id, kind }) => ({ id, kind })))}.`);
    }
    if (rows.some((row) => row.status !== "pending")) {
      throw new Error("An anonymous production HTTP request bypassed the pending private queue state.");
    }
    if (new Set(missing.map((row) => row.contentFingerprint)).size !== 1
      || new Set(missing.map((row) => row.contributorKey)).size !== 2
      || new Set(missing.map((row) => row.idempotencyKeyHash)).size !== 1) {
      throw new Error("Stable retry or same-key independent-contributor demand grouping failed through production HTTP.");
    }
    const outcomes = new Set(fitReports.map((row) => row.payload.outcome));
    if (!outcomes.has("print_failed") || !outcomes.has("does_not_fit") || outcomes.size !== 2) {
      throw new Error("Production HTTP collapsed print_failed and does_not_fit outcomes.");
    }

    const serializedPayloads = JSON.stringify(rows.map((row) => row.payload));
    for (const forbidden of [
      "challengeToken",
      "contributionConsent",
      "emailFollowUpConsent",
      "idempotencyKey",
      "privacyConsent",
      "website",
      "wp08-http-one@example.invalid",
      "wp08-http-two@example.invalid",
      "wp08-http-evidence@example.invalid",
    ]) assertExcludes(serializedPayloads, forbidden, "stored anonymous HTTP payloads");

    const [privacy] = await sql<{
      contactRows: number;
      followUps: number;
      honeypotRows: number;
      publicLeaks: number;
      publicationWrites: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions
          WHERE id = ANY(${rows.map((row) => row.id)}::uuid[]) AND contact_email IS NOT NULL) AS "contactRows",
        (SELECT count(*)::int FROM submission_email_follow_ups
          WHERE submission_id = ANY(${rows.map((row) => row.id)}::uuid[])) AS "followUps",
        (SELECT count(*)::int FROM submissions
          WHERE payload->>'brand' = 'WP08_HTTP_HONEYPOT_SENTINEL') AS "honeypotRows",
        (
          (SELECT count(*)::int FROM public_catalogue_fitments
            WHERE to_jsonb(public_catalogue_fitments)::text LIKE '%WP08_HTTP%')
          + (SELECT count(*)::int FROM public_catalogue_unavailable_sources
            WHERE to_jsonb(public_catalogue_unavailable_sources)::text LIKE '%WP08_HTTP%')
          + (SELECT count(*)::int FROM public_search_documents
            WHERE to_jsonb(public_search_documents)::text LIKE '%WP08_HTTP%')
        ) AS "publicLeaks",
        (
          (SELECT count(*)::int FROM fitments WHERE slug = 'wp08-http-latch')
          + (SELECT count(*)::int FROM designs WHERE slug LIKE 'wp08-http%')
        ) AS "publicationWrites"
    `;
    if (
      !privacy
      || privacy.contactRows !== 3
      || privacy.followUps !== 0
      || privacy.honeypotRows !== 0
      || privacy.publicLeaks !== 0
      || privacy.publicationWrites !== 0
    ) {
      throw new Error(`Production HTTP privacy/publication evidence failed: ${JSON.stringify(privacy)}.`);
    }

    const [rateFixture] = await sql<{ rows: number }[]>`
      SELECT count(*)::int AS rows
      FROM submissions
      WHERE intake_version = 1 AND payload->>'modelNumber' = 'RATE-100'
    `;
    if (!rateFixture || rateFixture.rows !== 1) {
      throw new Error(`Endpoint rate-limit fixture persisted ${rateFixture?.rows ?? 0} rows instead of one deduplicated row.`);
    }

    const highCountRateBuckets = await sql<{ requestCount: number; scope: string }[]>`
      SELECT scope, request_count AS "requestCount"
      FROM submission_rate_limit_buckets
      WHERE request_count >= 5
      ORDER BY scope, request_count
    `;
    const actualRateEvidence = highCountRateBuckets
      .map((row) => `${row.scope}|${row.requestCount}`)
      .sort();
    const expectedRateEvidence = [
      "anonymous-submission:global:10m|6",
      "anonymous-submission:global:10m|15",
      "anonymous-submission:global:24h|6",
      "anonymous-submission:global:24h|16",
      "anonymous-submission:missing_part:10m|5",
      "anonymous-submission:missing_part:24h|6",
    ].sort();
    if (JSON.stringify(actualRateEvidence) !== JSON.stringify(expectedRateEvidence)) {
      throw new Error(`Production HTTP rate-bucket evidence was unexpected: ${JSON.stringify(actualRateEvidence)}.`);
    }

    const evidenceSubmission = fitReports.find((row) => typeof row.payload.evidenceUrl === "string");
    if (!evidenceSubmission) throw new Error("Production HTTP evidence submission was not stored privately.");
    const nonEvidenceSubmission = missing[0];
    if (!nonEvidenceSubmission) throw new Error("Production HTTP non-evidence fixture was not stored privately.");
    return Object.freeze({
      evidenceSubmissionId: evidenceSubmission.id,
      nonEvidenceSubmissionId: nonEvidenceSubmission.id,
    });
  } finally {
    await sql.end();
  }
}

async function assertPrivateEvidenceAuthorization(
  submissionIds: Readonly<{ evidenceSubmissionId: string; nonEvidenceSubmissionId: string }>,
  authentication: AuthenticationFixture,
): Promise<void> {
  const submissionId = submissionIds.evidenceSubmissionId;
  const endpoint = `/api/admin/submissions/${submissionId}/evidence`;
  const nonstaffAal2 = await authentication.issueToken(ids.nonstaffAuth, "render-nonstaff@example.invalid", "aal2");
  const editorAal1 = await authentication.issueToken(ids.editorAuth, "render-editor@example.invalid", "aal1");
  const editorAal2 = await authentication.issueToken(ids.editorAuth, "render-editor@example.invalid", "aal2");
  const reviewerAal1 = await authentication.issueToken(ids.reviewerAuth, "render-reviewer@example.invalid", "aal1");
  const reviewerAal2 = await authentication.issueToken(ids.reviewerAuth, "render-reviewer@example.invalid", "aal2");
  const adminAal1 = await authentication.issueToken(ids.adminAuth, "render-admin@example.invalid", "aal1");
  const adminAal2 = await authentication.issueToken(ids.adminAuth, "render-admin@example.invalid", "aal2");

  const editorQueue = await privateStaffRequest("/api/admin/queue", editorAal1, 200);
  assertIncludes(editorQueue.body, "HTTP-100", "AAL1 redacted private queue");
  const queueBody = JSON.parse(editorQueue.body) as {
    submissions?: Array<{
      demandCount?: unknown;
      kind?: unknown;
      payload?: Record<string, unknown>;
    }>;
  };
  const httpDemand = (queueBody.submissions ?? []).filter((submission) =>
    submission.kind === "missing_part" && submission.payload?.modelNumber === "HTTP-100");
  if (httpDemand.length !== 2 || httpDemand.some((submission) => submission.demandCount !== 2)) {
    throw new Error(`Production HTTP demand aggregation was incorrect: ${JSON.stringify(httpDemand)}.`);
  }
  for (const forbidden of [
    "wp08-http-one@example.invalid",
    "wp08-http-two@example.invalid",
    "wp08-http-evidence@example.invalid",
    "WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
    "contact_email",
    "contributor_key",
    "content_fingerprint",
    "idempotency_key_hash",
    "request_fingerprint",
    ...databaseSecretSentinels,
  ]) assertExcludes(editorQueue.body, forbidden, "AAL1 redacted private queue");
  const reviewerQueueAal1 = await privateStaffRequest("/api/admin/queue", reviewerAal1, 403);
  assertIncludes(reviewerQueueAal1.body, "MFA_REQUIRED", "reviewer AAL1 private queue denial");

  for (const [label, token, expectedStatus, expectedCode] of [
    ["anonymous", null, 401, "AUTH_REQUIRED"],
    ["authenticated nonstaff aal2", nonstaffAal2, 403, "STAFF_NOT_FOUND"],
    ["editor aal1", editorAal1, 403, "FORBIDDEN"],
    ["editor aal2", editorAal2, 403, "FORBIDDEN"],
    ["reviewer aal1", reviewerAal1, 403, "MFA_REQUIRED"],
    ["admin aal1", adminAal1, 403, "MFA_REQUIRED"],
  ] as const) {
    const response = await privateStaffRequest(endpoint, token, expectedStatus);
    assertIncludes(response.body, expectedCode, `${label} private evidence denial`);
    assertPrivateDataAbsent(response.body, `${label} private evidence denial`);
  }

  for (const [label, token] of [["reviewer aal2", reviewerAal2], ["admin aal2", adminAal2]] as const) {
    const response = await privateStaffRequest(endpoint, token, 200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    if (body.submissionId !== submissionId
      || body.evidenceUrl !== "https://example.invalid/private-fit?token=WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL"
      || Object.keys(body).sort().join(",") !== "evidenceUrl,submissionId") {
      throw new Error(`${label} private evidence detail returned an unsafe shape: ${response.body}.`);
    }
    for (const forbidden of [
      "wp08-http-one@example.invalid",
      "wp08-http-two@example.invalid",
      "wp08-http-evidence@example.invalid",
      "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
      "WP08_MODERATION_ONLY_SENTINEL",
      "contact_email",
      "contributor_key",
      "content_fingerprint",
      ...databaseSecretSentinels,
    ]) assertExcludes(response.body, forbidden, `${label} private evidence detail`);
  }

  for (const [label, unavailableId] of [
    ["non-evidence submission", submissionIds.nonEvidenceSubmissionId],
    ["guessed submission", "70000000-0000-4000-8000-000000000099"],
  ] as const) {
    const response = await privateStaffRequest(
      `/api/admin/submissions/${unavailableId}/evidence`,
      reviewerAal2,
      404,
    );
    const body = JSON.parse(response.body) as {
      error?: { code?: unknown; message?: unknown; requestId?: unknown };
    };
    if (body.error?.code !== "SUBMISSION_EVIDENCE_NOT_FOUND"
      || body.error.message !== "submission evidence not found"
      || typeof body.error.requestId !== "string"
      || Object.keys(body).join(",") !== "error"
      || Object.keys(body.error).sort().join(",") !== "code,message,requestId") {
      throw new Error(`${label} did not return the generic private evidence not-found shape: ${response.body}.`);
    }
    assertPrivateDataAbsent(response.body, `${label} private evidence not-found response`);
  }
}

async function privateStaffRequest(
  pathname: string,
  token: string | null,
  expectedStatus: number,
): Promise<HttpResponse> {
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${origin}${pathname}`, { headers, redirect: "manual" });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${pathname} returned ${response.status}, expected ${expectedStatus}. Body: ${body.slice(0, 500)}`);
  }
  assertPrivateResponseHeaders(response.headers, pathname);
  return Object.freeze({ body, headers: response.headers, status: response.status });
}

async function waitForServer(server: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Next.js server exited before readiness.\n${output()}`);
    try {
      const response = await fetch(`${origin}/methodology`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the production server.\n${output()}`);
}

async function request(path: string, expectedStatus: number): Promise<{ body: string; location: string | null }> {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}. Body: ${body.slice(0, 500)}`);
  }
  return { body, location: response.headers.get("location") };
}

async function assertNotFound(pathname: string): Promise<void> {
  const response = await request(pathname, 404);
  if (response.location !== null) throw new Error(`${pathname} exposed a redirect location: ${response.location}.`);
  assertIncludes(response.body, "That record is not in the index", `${pathname} generic 404`);
  assertPrivateDataAbsent(response.body, `${pathname} 404 HTML/flight`);
}

function assertIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) throw new Error(`${label} did not include ${JSON.stringify(expected)}.`);
}

function assertExcludes(value: string, forbidden: string, label: string): void {
  if (value.includes(forbidden)) throw new Error(`${label} exposed ${JSON.stringify(forbidden)}.`);
}

function assertPrivateDataAbsent(value: string, label: string): void {
  for (const sentinel of [...privateSentinels, ...databaseSecretSentinels]) assertExcludes(value, sentinel, label);
  assertExcludes(value, "WP07_UNCITED_ALIAS_SENTINEL", label);
  assertExcludes(value, "WP07_PRIVATE_DESIGN_SENTINEL", label);
}

function assertClientBundleSafe(): void {
  const root = path.join(process.cwd(), ".next", "static");
  const forbidden = [...privateSentinels, ...databaseSecretSentinels, "WP07_UNCITED_ALIAS_SENTINEL", "WP07_PRIVATE_DESIGN_SENTINEL", "public_catalogue_fitments"];
  for (const file of walkFiles(root)) {
    if (!file.endsWith(".js")) continue;
    const contents = readFileSync(file, "utf8");
    for (const marker of forbidden) {
      if (contents.includes(marker)) throw new Error(`Client bundle ${path.relative(process.cwd(), file)} exposed ${JSON.stringify(marker)}.`);
    }
  }
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => server.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
