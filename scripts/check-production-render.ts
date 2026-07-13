import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import sharp from "sharp";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import {
  assessAnalyticsRoleMemberships,
  type AnalyticsRoleMembership,
} from "../src/domain/analytics-role-membership";
import {
  assessSubmissionRoleMemberships,
  type SubmissionRoleMembership,
} from "../src/domain/submission-role-membership";
import * as schema from "../src/db/schema";
import {
  deriveSubmissionHmacKeyCommitment,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
} from "../src/lib/submission-key-pin";

const port = 3197;
const demoPort = 3198;
const origin = `http://127.0.0.1:${port}`;
const analyticsServiceRole = "repairprint_analytics_service";
const submissionServiceRole = "repairprint_submission_service";
const sourceServiceRole = "repairprint_source_service";
const sourceWorkerSecret = "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08";
let sourceDatabaseUrlForRender = "";
let analyticsDatabaseUrlForRender = "";
const testTurnstileSecret = "1x0000000000000000000000000000000AA";
const privateSentinels = [
  "WP07_PRIVATE_RENDER_SENTINEL",
  "private-render@example.invalid",
  "WP08_MODERATION_ONLY_SENTINEL",
  "WP08_PRIVATE_CONTRIBUTOR_SENTINEL",
  "WP08_PRIVATE_ACTOR_SENTINEL",
  "WP08_PRIVATE_REQUEST_SENTINEL",
  "WP08_PRIVATE_CONTENT_SENTINEL",
  "70000000-0000-4000-8000-000000000037",
  "70000000-0000-4000-8000-000000000037",
  "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
  "WP08_HTTP_HONEYPOT_SENTINEL",
  "WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
  "WP08_HTTP_RATE_SENTINEL",
  "WP08_IDEMPOTENCY_PRIVATE_SENTINEL",
  "WP08_CONCURRENT_PRIVATE_SENTINEL",
  "WP08_KEY_PIN_PRIVATE_SENTINEL",
  "WP08_PIN_RACE_PRIVATE_SENTINEL",
  "WP08_UUID_PRIVATE_NOTES_SENTINEL",
  "WP08_RESTART_PRIVATE_K1_SENTINEL",
  "WP08_RESTART_PRIVATE_K2_SENTINEL",
  "WP08_RESTART_PRIVATE_POLICY_",
  "WP08_FAILURE_INJECTION_PRIVATE_",
  "WP08_TEST_INJECTED_DATABASE_FAILURE_SENTINEL",
  "WP08_CLEANUP_RACE_PRIVATE_K1_SENTINEL",
  "WP08_CLEANUP_RACE_PRIVATE_K2_SENTINEL",
  "wp08-render-contributor-private-v1",
  "wp08-render-privacy-private-v1",
  "wp08-render-retention-v1",
  "wp08-render-retention-v2",
  "wp08-uuid-private@example.invalid",
  "wp08-failure-private@example.invalid",
  "wp08-concurrent-contact@example.invalid",
  "WP08-IDEM-",
  "wp08-http-one@example.invalid",
  "wp08-http-two@example.invalid",
  "wp08-http-evidence@example.invalid",
  "wp08-http-rate@example.invalid",
  "wp08-global-rate-",
  "wp08-ipv6-rate-",
  "wp08-contact-original@example.invalid",
  "wp08-contact-changed@example.invalid",
  "wp08-contact-added@example.invalid",
  "wp08-contact-removed@example.invalid",
  "wp08-contact-normalized@example.invalid",
  "wp08-contact-invalid@example.invalid",
  "wp08-contact-consent@example.invalid",
  "wp08-binding-contact@example.invalid",
  "render-editor@example.invalid",
  "render-reviewer@example.invalid",
  "render-admin@example.invalid",
  "render-nonstaff@example.invalid",
  "postgres://",
  "postgresql://",
  "DATABASE_URL",
  "moderation_status",
  "privacy_consent",
  "contribution_consent",
  "email_follow_up_consent",
  "contributor_terms_version",
  "privacy_notice_version",
  "contact_consent_version",
  "retention_policy_version",
  "reviewed_by",
  "supporting_excerpt",
  "contact_email",
  "contributor_key",
  "request_fingerprint",
  "content_fingerprint",
  "idempotency_actor_key",
  "idempotencyActorKey",
  "submission_idempotency_bindings",
  "SUBMISSION_DATABASE_URL",
  "SUBMISSION_HMAC_SECRET",
  "TURNSTILE_SECRET_KEY",
  "MEDIA_CAPABILITY_SECRET",
  "SOURCE_DATABASE_URL",
  "SOURCE_LINK_WORKER_ACTOR_ID",
  "SOURCE_LINK_WORKER_SECRET",
  "ANALYTICS_DATABASE_URL",
  "repairprint_analytics_service",
  "private_analytics_daily_aggregates",
  "record_private_analytics_event",
  "WP11_ANALYTICS_RAW_QUERY_SENTINEL",
  "wp11-analytics-private@example.invalid",
  "repairprint_source_service",
  "source_policy_reviews",
  "source_candidate_versions",
  "source_candidate_acquisitions",
  "FixtureThingiverseAdapter",
  "safe-source-network",
  "SUPABASE_SERVICE_ROLE_KEY",
  "private_media_consents",
  "private_media_upload_sessions",
  "private_media_pending_objects",
  "quarantine/aa/WP09_PRIVATE_PATH_SENTINEL",
  testTurnstileSecret,
  "WP09_STORAGE_SERVICE_KEY_SENTINEL",
  "6d6f2cffd13b8a5fd7cb9a66963cac91ce989326e0bd22eebe3f434469efb38f",
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
  privateIntake: "70000000-0000-4000-8000-000000000044",
  modelVariant: "70000000-0000-4000-8000-000000000045",
  variantIdentifier: "70000000-0000-4000-8000-000000000046",
  variantProductComponent: "70000000-0000-4000-8000-000000000047",
  variantIdentifierCitation: "70000000-0000-4000-8000-000000000048",
  variantModelNameCitation: "70000000-0000-4000-8000-000000000049",
  variantMappingCitation: "70000000-0000-4000-8000-000000000050",
  variantRevisionCitation: "70000000-0000-4000-8000-000000000051",
  variantFitment: "70000000-0000-4000-8000-000000000052",
  variantEvidence: "70000000-0000-4000-8000-000000000053",
  emptyModel: "70000000-0000-4000-8000-000000000054",
  emptyIdentifier: "70000000-0000-4000-8000-000000000055",
  emptyIdentifierCitation: "70000000-0000-4000-8000-000000000056",
  emptyModelNameCitation: "70000000-0000-4000-8000-000000000057",
  emptyProductComponent: "70000000-0000-4000-8000-000000000058",
  emptyMappingCitation: "70000000-0000-4000-8000-000000000059",
  disputedFitment: "70000000-0000-4000-8000-000000000060",
  oemPart: "70000000-0000-4000-8000-000000000061",
  componentAliasCitation: "70000000-0000-4000-8000-000000000062",
  oemRecordCitation: "70000000-0000-4000-8000-000000000063",
} as const;

let databaseSecretSentinels: string[] = [];
const privateReceiptSentinels: string[] = [];
const privateDemandSentinels: string[] = [];

type AuthenticationFixture = Readonly<{
  close: () => Promise<void>;
  issueToken: (authUserId: string, email: string, aal: "aal1" | "aal2") => Promise<string>;
  storedObjectPaths: () => readonly string[];
  origin: string;
}>;

type StaffSigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

type RunningNextServer = Readonly<{
  child: ChildProcess;
  origin: string;
  output: () => string;
  pid: number;
  port: number;
  turnstileNonce: string;
}>;

type RestartFixture = Readonly<{
  clientIp: string;
  k1: Readonly<Record<string, unknown>>;
  k2: Readonly<Record<string, unknown>>;
  receiptId: string;
}>;

type PolicyRestartFixture = Readonly<{
  clientIp: string;
  k1: Readonly<Record<string, unknown>>;
  receiptId: string;
}>;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (!databaseUrl && process.env.CI !== "true") {
    console.log("Production render check skipped locally: set DATABASE_TEST_URL to the guarded repairprint_test database.");
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_TEST_URL is required for the production render check in CI.");
  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");
  const hmacKeyA = generateSubmissionTestHmacKey();
  const hmacKeyB = generateSubmissionTestHmacKey();
  const submissionDatabaseUrl = await provisionSubmissionServiceRole(databaseUrl);
  const authentication = await startAuthenticationFixture();

  try {
    await prepareDatabase(databaseUrl, hmacKeyA);
    sourceDatabaseUrlForRender = await provisionSourceServiceRole(databaseUrl);
    analyticsDatabaseUrlForRender = await provisionAnalyticsServiceRole(databaseUrl);
    databaseSecretSentinels = [
      databaseUrl,
      encodeURIComponent(databaseUrl),
      submissionDatabaseUrl,
      encodeURIComponent(submissionDatabaseUrl),
      new URL(submissionDatabaseUrl).password,
      sourceDatabaseUrlForRender,
      encodeURIComponent(sourceDatabaseUrlForRender),
      new URL(sourceDatabaseUrlForRender).password,
      analyticsDatabaseUrlForRender,
      encodeURIComponent(analyticsDatabaseUrlForRender),
      new URL(analyticsDatabaseUrlForRender).password,
      sourceWorkerSecret,
      hmacKeyA,
      hmacKeyB,
    ];
    await assertSubmissionServiceBoundary(submissionDatabaseUrl);
    await assertSourceServiceBoundary(sourceDatabaseUrlForRender);
    await assertAnalyticsServiceBoundary(analyticsDatabaseUrlForRender);
    runProductionBuild(databaseUrl, submissionDatabaseUrl, authentication.origin, hmacKeyA);
    await assertKeyPinFailureModes(databaseUrl, submissionDatabaseUrl, authentication.origin, hmacKeyA);
    await provisionSubmissionKeyPin(databaseUrl, hmacKeyA);
    await assertSubmissionKeyPinProvisioningUtility(databaseUrl, hmacKeyA, hmacKeyB);
    await runHttpAssertions(databaseUrl, submissionDatabaseUrl, authentication, hmacKeyA, hmacKeyB);
  } finally {
    await authentication.close();
  }
}

function generateSubmissionTestHmacKey(): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomBytes(32).toString("hex");
    try {
      deriveSubmissionHmacKeyCommitment(candidate);
      return candidate;
    } catch {
      // Regenerate the exceptionally unlikely disallowed/repeating test key.
    }
  }
  throw new Error("Could not generate a valid ephemeral submission HMAC key.");
}

async function prepareDatabase(databaseUrl: string, hmacKey: string): Promise<void> {
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  const database = drizzle(sql, { schema });
  const now = new Date("2026-07-12T06:00:00Z");

  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await sql.unsafe('CREATE SCHEMA "public"');
    await migrate(database, { migrationsFolder: "drizzle" });
    await database.insert(schema.submissionHmacKeyPin).values({
      hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
      keyCommitment: deriveSubmissionHmacKeyCommitment(hmacKey),
      singleton: true,
    });

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
        mfaRequired: true,
        role: "reviewer",
        status: "active",
      },
      {
        id: ids.adminStaff,
        authUserId: ids.adminAuth,
        email: "render-admin@example.invalid",
        mfaRequired: true,
        role: "admin",
        status: "active",
      },
    ]);

    await database.insert(schema.sourcePlatformPolicies).values({
      platform: "render.example",
      policy: "creator_submission",
      termsUrl: "https://render.example/terms",
      termsChecksum: "f".repeat(64),
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

    await database.insert(schema.productModels).values([
      {
        id: ids.model,
        publicId: "mdl_render_rx100",
        brandId: ids.brand,
        categoryId: ids.category,
        modelName: "RX-100",
        slug: "rx-100",
        marketCodes: ["GLOBAL"],
        labelLocation: "Underside rating label",
        summary: null,
        publicationStatus: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.modelVariant,
        publicId: "mdl_render_rx100_eu",
        brandId: ids.brand,
        categoryId: ids.category,
        modelName: "RX/100 EU",
        slug: "rx-100-eu",
        marketCodes: ["EU"],
        labelLocation: "Underside rating label",
        summary: null,
        publicationStatus: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.emptyModel,
        publicId: "mdl_render_rx_empty",
        brandId: ids.brand,
        categoryId: ids.category,
        modelName: "RX-EMPTY",
        slug: "rx-empty",
        marketCodes: ["GLOBAL"],
        labelLocation: "Underside rating label",
        summary: null,
        publicationStatus: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
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
      {
        id: ids.variantIdentifier,
        productModelId: ids.modelVariant,
        displayValue: "RX/100",
        strictKey: "RX/100",
        looseKey: "RX100",
        identifierType: "model_number",
        marketCode: "EU",
        sourceCitationId: null,
      },
      {
        id: ids.emptyIdentifier,
        productModelId: ids.emptyModel,
        displayValue: "RX-EMPTY",
        strictKey: "RX-EMPTY",
        looseKey: "RXEMPTY",
        identifierType: "model_number",
        sourceCitationId: null,
      },
    ]);
    await database.insert(schema.components).values({
      id: ids.component,
      categoryId: ids.category,
      name: "Dust-bin latch",
      slug: "dust-bin-latch",
      commonNames: ["Bin clip"],
    });
    await database.insert(schema.oemParts).values({
      id: ids.oemPart,
      publicId: "oem_render_rx100_latch",
      brandId: ids.brand,
      componentId: ids.component,
      partNumberDisplay: "OEM-RX-100",
      strictPartKey: "OEM-RX-100",
      loosePartKey: "OEMRX100",
      name: "Dust-bin latch assembly",
      publicationStatus: "published",
    });
    await database.insert(schema.productComponents).values([
      {
        id: ids.productComponent,
        productModelId: ids.model,
        componentId: ids.component,
        oemPartId: ids.oemPart,
        mappingStatus: "accepted",
        sourceCitationId: null,
      },
      {
        id: ids.variantProductComponent,
        productModelId: ids.modelVariant,
        componentId: ids.component,
        oemPartId: ids.oemPart,
        mappingStatus: "accepted",
        sourceCitationId: null,
      },
      {
        id: ids.emptyProductComponent,
        productModelId: ids.emptyModel,
        componentId: ids.component,
        oemPartId: ids.oemPart,
        mappingStatus: "accepted",
        sourceCitationId: null,
      },
    ]);

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
      acceptedCitation(ids.variantIdentifierCitation, ids.liveSource, "product_identifier", ids.variantIdentifier, "display_value", { displayValue: "RX/100" }, now),
      acceptedCitation(ids.variantModelNameCitation, ids.liveSource, "product_model", ids.modelVariant, "model_name", { modelName: "RX/100 EU" }, now),
      acceptedCitation(ids.variantMappingCitation, ids.liveSource, "product_component", ids.variantProductComponent, "mapping", { model: "RX/100 EU", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.variantRevisionCitation, ids.liveSource, "design_revision", ids.liveRevision, "claimed_compatibility", { model: "RX/100 EU", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.emptyIdentifierCitation, ids.liveSource, "product_identifier", ids.emptyIdentifier, "display_value", { displayValue: "RX-EMPTY" }, now),
      acceptedCitation(ids.emptyModelNameCitation, ids.liveSource, "product_model", ids.emptyModel, "model_name", { modelName: "RX-EMPTY" }, now),
      acceptedCitation(ids.emptyMappingCitation, ids.liveSource, "product_component", ids.emptyProductComponent, "mapping", { model: "RX-EMPTY", component: "Dust-bin latch" }, now),
      acceptedCitation(ids.componentAliasCitation, ids.liveSource, "component", ids.component, "common_names", { commonNames: ["Bin clip"] }, now),
      acceptedCitation(ids.oemRecordCitation, ids.liveSource, "oem_part", ids.oemPart, "record", { partNumberDisplay: "OEM-RX-100", name: "Dust-bin latch assembly" }, now),
    ]);
    await sql`UPDATE product_identifiers SET source_citation_id = ${ids.identifierCitation} WHERE id = ${ids.primaryIdentifier}`;
    await sql`UPDATE product_components SET source_citation_id = ${ids.mappingCitation} WHERE id = ${ids.productComponent}`;
    await sql`UPDATE product_identifiers SET source_citation_id = ${ids.variantIdentifierCitation} WHERE id = ${ids.variantIdentifier}`;
    await sql`UPDATE product_identifiers SET source_citation_id = ${ids.emptyIdentifierCitation} WHERE id = ${ids.emptyIdentifier}`;
    await sql`UPDATE product_components SET source_citation_id = ${ids.variantMappingCitation} WHERE id = ${ids.variantProductComponent}`;
    await sql`UPDATE product_components SET source_citation_id = ${ids.emptyMappingCitation} WHERE id = ${ids.emptyProductComponent}`;

    await database.insert(schema.safetyReviews).values([
      {
        productComponentId: ids.productComponent,
        safetyClass: "low",
        signals: ["low_load_clip"],
        failureConsequence: "Inconvenience only",
        rationale: "Independently reviewed low-load external latch.",
        rulesetVersion: "safety-v1",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      },
      {
        productComponentId: ids.variantProductComponent,
        safetyClass: "low",
        signals: ["low_load_clip"],
        failureConsequence: "Inconvenience only",
        rationale: "Independently reviewed low-load external latch for the EU variant.",
        rulesetVersion: "safety-v1",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      },
      {
        productComponentId: ids.emptyProductComponent,
        safetyClass: "low",
        signals: ["low_load_clip"],
        failureConsequence: "Inconvenience only",
        rationale: "Reviewed low-load external latch candidate for the empty-result model fixture.",
        rulesetVersion: "safety-v1",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      },
    ]);
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
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.variantFitment,
        publicId: "fit_render_variant_r1",
        slug: "render-rx100-eu-latch-r1",
        designRevisionId: ids.liveRevision,
        productComponentId: ids.variantProductComponent,
        confidenceLevel: "creator_listed",
        confidenceScore: 55,
        confidenceVersion: "fitment-v1",
        publicationStatus: "published",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: new Date("2026-07-12T06:00:30Z"),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.disputedFitment,
        publicId: "fit_render_disputed_empty_r1",
        slug: "render-rx-empty-disputed-r1",
        designRevisionId: ids.liveRevision,
        productComponentId: ids.emptyProductComponent,
        confidenceLevel: "disputed",
        confidenceScore: 0,
        confidenceVersion: "fitment-v1",
        publicationStatus: "published",
        reviewedBy: ids.reviewer,
        reviewedAt: now,
        lastComputedAt: now,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
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
      {
        id: ids.variantEvidence,
        fitmentId: ids.variantFitment,
        evidenceKind: "creator_claim",
        outcome: "fits_without_modification",
        sourceCitationId: ids.variantRevisionCitation,
        actorIndependenceKey: "render-creator-live-variant",
        exactModel: true,
        exactDesignRevision: true,
        summary: "Creator separately cites the exact RX/100 EU model and r1 design revision.",
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
    await database.transaction(async (transaction) => {
      const [privateParent] = await transaction.insert(schema.submissions).values({
        id: ids.privateSubmission,
        kind: "design_submission",
        status: "in_review",
        intakeVersion: 1,
        hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
        contributorKey: "d4".repeat(32),
        contentFingerprint: "e5".repeat(32),
        matchedEntityType: "design",
        matchedEntityId: ids.liveDesign,
        payload: {
          brand: "WP08 private render fixture",
          componentName: "Private latch",
          modelNumber: "WP08-PRIVATE-100",
        },
        reviewedBy: ids.reviewer,
        reviewedAt: now,
      }).returning({ receiptId: schema.submissions.receiptId });
      if (!privateParent) throw new Error("Private submission parent fixture was not created.");

      await transaction.insert(schema.submissionIdempotencyBindings).values({
        id: ids.privateIntake,
        acceptedAt: now,
        challengeProvider: "turnstile",
        challengeVerifiedAt: now,
        contactConsentVersion: "wp08-email-follow-up-v1",
        contactDigest: "f6".repeat(32),
        contactPresent: true,
        contactRetentionExpiresAt: new Date("2026-08-12T06:00:00Z"),
        contributionConsent: true,
        contributorTermsVersion: "wp08-render-contributor-private-v1",
        emailFollowUpConsent: true,
        hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
        idempotencyActorKey: "a1".repeat(32),
        idempotencyKeyHash: "b2".repeat(32),
        kind: "design_submission",
        payload: {
          notes: "WP07_PRIVATE_RENDER_SENTINEL",
          moderationNotes: "WP08_MODERATION_ONLY_SENTINEL",
        },
        privacyConsent: true,
        privacyNoticeVersion: "wp08-render-privacy-private-v1",
        receiptId: privateParent.receiptId,
        requestFingerprint: "c3".repeat(32),
        retentionExpiresAt: new Date("2026-10-12T06:00:00Z"),
        retentionPolicyVersion: "wp08-render-retention-v1",
        submissionId: ids.privateSubmission,
      });
      await transaction.insert(schema.submissionIntakeContacts).values({
        contactDigest: "f6".repeat(32),
        contactEmail: "private-render@example.invalid",
        intakeId: ids.privateIntake,
      });
      await transaction.insert(schema.submissionEmailFollowUps).values({
        id: ids.privateFollowUp,
        availableAt: now,
        followUpKey: `intake:${ids.privateIntake}:moderator_question:${ids.privateFollowUp}`,
        intakeId: ids.privateIntake,
        qualifyingEvent: "moderator_question",
        submissionId: ids.privateSubmission,
        templateKey: "moderator-follow-up",
      });
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
    const normalizedMaterialTimestamp = now.toISOString();
    await sql`UPDATE brands SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE categories SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE product_models SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE product_identifiers SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE components SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE product_components SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE oem_parts SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE creators SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE sources SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE source_citations SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE designs SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE design_revisions SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE fitments SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE fitment_evidence SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE safety_reviews SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
    await sql`UPDATE print_recipes SET created_at = ${normalizedMaterialTimestamp}, updated_at = ${normalizedMaterialTimestamp}`;
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

async function provisionSourceServiceRole(databaseUrl: string): Promise<string> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const password = `rp_source_${randomBytes(24).toString("hex")}`;
  try {
    await owner.unsafe(`ALTER ROLE ${sourceServiceRole} WITH LOGIN PASSWORD '${password}'`);
  } finally {
    await owner.end();
  }
  const serviceUrl = new URL(databaseUrl);
  serviceUrl.username = sourceServiceRole;
  serviceUrl.password = password;
  return serviceUrl.toString();
}

async function provisionAnalyticsServiceRole(databaseUrl: string): Promise<string> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const password = `rp_analytics_${randomBytes(24).toString("hex")}`;
  try {
    const [role] = await owner<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${analyticsServiceRole}) AS exists
    `;
    if (!role?.exists) {
      throw new Error("Analytics service role was not created by the applied migration.");
    }
    await owner.unsafe(`ALTER ROLE ${analyticsServiceRole} WITH LOGIN PASSWORD '${password}'`);
  } finally {
    await owner.end();
  }
  const serviceUrl = new URL(databaseUrl);
  serviceUrl.username = analyticsServiceRole;
  serviceUrl.password = password;
  return serviceUrl.toString();
}

async function assertAnalyticsServiceBoundary(analyticsDatabaseUrl: string): Promise<void> {
  const service = postgres(analyticsDatabaseUrl, { prepare: false, max: 1 });
  try {
    const memberships = await service<AnalyticsRoleMembership[]>`
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
      WHERE granted_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
         OR member_role.rolname IN ('repairprint_analytics_service', 'repairprint_analytics_maintenance')
      ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    `;
    const membershipAssessment = assessAnalyticsRoleMemberships(memberships);
    if (!membershipAssessment.valid) {
      throw new Error(`Analytics role membership allowlist is invalid: ${JSON.stringify(membershipAssessment)}.`);
    }

    const [boundary] = await service<{
      currentUser: string;
      directRoutinePrivileges: number;
      directTablePrivileges: number;
      forbiddenOwnerships: number;
      hasRecorderExecute: boolean;
      hasSchemaUsage: boolean;
      leastPrivileged: boolean;
      unrelatedFunctionExecute: boolean;
    }[]>`
      SELECT
        current_user AS "currentUser",
        has_schema_privilege(current_user, 'public', 'USAGE') AS "hasSchemaUsage",
        has_function_privilege(
          current_user,
          'public.record_private_analytics_event(text,jsonb)',
          'EXECUTE'
        ) AS "hasRecorderExecute",
        has_function_privilege(
          current_user,
          'public.cleanup_expired_submission_intakes(integer)',
          'EXECUTE'
        ) AS "unrelatedFunctionExecute",
        (SELECT rolcanlogin AND NOT (
            rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls
          ) FROM pg_roles WHERE rolname = current_user) AS "leastPrivileged",
        (SELECT count(*)::int FROM information_schema.table_privileges
          WHERE grantee = current_user AND table_schema = 'public') AS "directTablePrivileges",
        (SELECT count(*)::int FROM information_schema.routine_privileges
          WHERE grantee = current_user AND routine_schema = 'public') AS "directRoutinePrivileges",
        (
          (SELECT count(*)::int FROM pg_database AS database
            WHERE database.datname = current_database()
              AND database.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_namespace AS namespace
            WHERE namespace.nspname = 'public'
              AND namespace.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_proc AS procedure
            INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
        ) AS "forbiddenOwnerships"
    `;
    let aggregateReadDenied = false;
    let catalogueReadDenied = false;
    try {
      await service`SELECT count(*) FROM public.private_analytics_daily_aggregates`;
    } catch (error) {
      aggregateReadDenied = databaseErrorCode(error) === "42501";
    }
    try {
      await service`SELECT count(*) FROM public.public_catalogue_fitments`;
    } catch (error) {
      catalogueReadDenied = databaseErrorCode(error) === "42501";
    }
    if (
      boundary?.currentUser !== analyticsServiceRole
      || !boundary.hasSchemaUsage
      || !boundary.hasRecorderExecute
      || !boundary.leastPrivileged
      || boundary.unrelatedFunctionExecute
      || boundary.directTablePrivileges !== 0
      || boundary.directRoutinePrivileges !== 1
      || boundary.forbiddenOwnerships !== 0
      || !aggregateReadDenied
      || !catalogueReadDenied
    ) {
      throw new Error(
        `Analytics service connection boundary is invalid: ${JSON.stringify({ boundary, aggregateReadDenied, catalogueReadDenied })}.`,
      );
    }
  } finally {
    await service.end();
  }
}

async function assertSourceServiceBoundary(sourceDatabaseUrl: string): Promise<void> {
  const service = postgres(sourceDatabaseUrl, { prepare: false, max: 1 });
  try {
    const [boundary] = await service<{ currentUser: string; intendedFunctions: number; unsafe: boolean }[]>`
      SELECT current_user AS "currentUser",
        (SELECT count(*)::int FROM (VALUES
          ('public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)'),
          ('public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)'),
          ('public.claim_source_link_check_jobs(text,integer,integer)'),
          ('public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)')
        ) AS intended(signature)
        WHERE has_function_privilege(current_user, intended.signature, 'EXECUTE')) AS "intendedFunctions",
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls OR NOT rolcanlogin
          FROM pg_roles WHERE rolname = current_user) AS unsafe
    `;
    let directReadDenied = false;
    let unrelatedFunctionDenied = false;
    try { await service`SELECT count(*) FROM source_candidates`; }
    catch (error) { directReadDenied = databaseErrorCode(error) === "42501"; }
    try { await service`SELECT public.refresh_source_public_search()`; }
    catch (error) { unrelatedFunctionDenied = databaseErrorCode(error) === "42501"; }
    if (boundary?.currentUser !== sourceServiceRole || boundary.intendedFunctions !== 4 || boundary.unsafe
      || !directReadDenied || !unrelatedFunctionDenied) {
      throw new Error(`Source service connection boundary is invalid: ${JSON.stringify({ boundary, directReadDenied, unrelatedFunctionDenied })}.`);
    }
  } finally {
    await service.end();
  }
}

async function assertSubmissionServiceBoundary(submissionDatabaseUrl: string): Promise<void> {
  const service = postgres(submissionDatabaseUrl, { prepare: false, max: 1 });
  try {
    const submissionRoleMemberships = await service<SubmissionRoleMembership[]>`
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
        `Submission role membership allowlist is invalid: ${JSON.stringify(submissionRoleMembershipAssessment)}.`,
      );
    }

    const [boundary] = await service<{
      currentUser: string;
      schemaUsage: boolean;
      submissionsRead: boolean;
      submissionsDelete: boolean;
      rateLimitsRead: boolean;
      rateLimitsDelete: boolean;
      followUpsRead: boolean;
      followUpsDelete: boolean;
      bindingsRead: boolean;
      bindingsDelete: boolean;
      contactsRead: boolean;
      contactsDelete: boolean;
      keyPinRead: boolean;
      keyPinDelete: boolean;
      cleanupExecute: boolean;
      mediaCleanupExecute: boolean;
      mediaQuarantineCleanupExecute: boolean;
      mediaPendingObjectCleanupExecute: boolean;
      mediaSessionsRead: boolean;
      mediaConsentsRead: boolean;
      mediaAssetsRead: boolean;
      mediaDerivativesRead: boolean;
      mediaPendingObjectsRead: boolean;
      mediaPendingObjectsDelete: boolean;
      mediaRedactionsRead: boolean;
      broadWritePrivileges: number;
      columnWritePrivileges: number;
      tableReadDeletePrivileges: number;
      staffRead: boolean;
      creatorsRead: boolean;
      catalogueRead: boolean;
      searchRead: boolean;
      roleElevated: boolean;
      forbiddenOwnerships: number;
    }[]>`
      SELECT
        current_user AS "currentUser",
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
          FROM pg_roles WHERE rolname = current_user) AS "roleElevated",
        (
          (SELECT count(*)::int FROM pg_database AS database
            WHERE database.datname = current_database()
              AND database.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_namespace AS namespace
            WHERE namespace.nspname = 'public'
              AND namespace.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          + (SELECT count(*)::int FROM pg_proc AS procedure
            INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
        ) AS "forbiddenOwnerships",
        has_schema_privilege(current_user, 'public', 'USAGE') AS "schemaUsage",
        has_table_privilege(current_user, 'public.submissions', 'SELECT') AS "submissionsRead",
        has_table_privilege(current_user, 'public.submissions', 'DELETE') AS "submissionsDelete",
        has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'SELECT') AS "rateLimitsRead",
        has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'DELETE') AS "rateLimitsDelete",
        has_table_privilege(current_user, 'public.submission_email_follow_ups', 'SELECT') AS "followUpsRead",
        has_table_privilege(current_user, 'public.submission_email_follow_ups', 'DELETE') AS "followUpsDelete",
        has_table_privilege(current_user, 'public.submission_idempotency_bindings', 'SELECT') AS "bindingsRead",
        has_table_privilege(current_user, 'public.submission_idempotency_bindings', 'DELETE') AS "bindingsDelete",
        has_table_privilege(current_user, 'public.submission_intake_contacts', 'SELECT') AS "contactsRead",
        has_table_privilege(current_user, 'public.submission_intake_contacts', 'DELETE') AS "contactsDelete",
        has_table_privilege(current_user, 'public.submission_hmac_key_pin', 'SELECT') AS "keyPinRead",
        has_table_privilege(current_user, 'public.submission_hmac_key_pin', 'DELETE') AS "keyPinDelete",
        has_function_privilege(current_user, 'public.cleanup_expired_submission_intakes(integer)', 'EXECUTE') AS "cleanupExecute",
        has_function_privilege(current_user, 'public.claim_expired_private_media(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_cleanup(uuid,uuid[])', 'EXECUTE') AS "mediaCleanupExecute",
        has_function_privilege(current_user, 'public.claim_private_media_quarantine_cleanup(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_quarantine_cleanup(uuid,uuid[])', 'EXECUTE') AS "mediaQuarantineCleanupExecute",
        has_function_privilege(current_user, 'public.claim_private_media_pending_object_cleanup(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_pending_object_cleanup(uuid,uuid[])', 'EXECUTE') AS "mediaPendingObjectCleanupExecute",
        has_table_privilege(current_user, 'public.private_media_upload_sessions', 'SELECT') AS "mediaSessionsRead",
        has_table_privilege(current_user, 'public.private_media_consents', 'SELECT') AS "mediaConsentsRead",
        has_table_privilege(current_user, 'public.private_media_assets', 'SELECT') AS "mediaAssetsRead",
        has_table_privilege(current_user, 'public.private_media_derivatives', 'SELECT') AS "mediaDerivativesRead",
        has_table_privilege(current_user, 'public.private_media_pending_objects', 'SELECT') AS "mediaPendingObjectsRead",
        has_table_privilege(current_user, 'public.private_media_pending_objects', 'DELETE') AS "mediaPendingObjectsDelete",
        has_table_privilege(current_user, 'public.private_media_redactions', 'SELECT') AS "mediaRedactionsRead",
        (SELECT count(*)::int FROM information_schema.table_privileges
          WHERE grantee = current_user AND table_schema = 'public'
            AND privilege_type IN ('SELECT', 'DELETE')) AS "tableReadDeletePrivileges",
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
      || boundary.submissionsDelete
      || !boundary.rateLimitsRead
      || !boundary.rateLimitsDelete
      || !boundary.followUpsRead
      || boundary.followUpsDelete
      || !boundary.bindingsRead
      || boundary.bindingsDelete
      || !boundary.contactsRead
      || boundary.contactsDelete
      || !boundary.keyPinRead
      || boundary.keyPinDelete
      || !boundary.cleanupExecute
      || !boundary.mediaCleanupExecute
      || !boundary.mediaQuarantineCleanupExecute
      || !boundary.mediaPendingObjectCleanupExecute
      || !boundary.mediaSessionsRead
      || !boundary.mediaConsentsRead
      || !boundary.mediaAssetsRead
      || !boundary.mediaDerivativesRead
      || !boundary.mediaPendingObjectsRead
      || !boundary.mediaPendingObjectsDelete
      || boundary.mediaRedactionsRead
      || boundary.tableReadDeletePrivileges !== 13
      || boundary.broadWritePrivileges !== 0
      || boundary.columnWritePrivileges !== 97
      || boundary.roleElevated
      || boundary.forbiddenOwnerships !== 0
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
  const storedObjects = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
      if (request.method === "GET" && requestUrl.pathname === "/auth/v1/.well-known/jwks.json") {
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
        response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }] }));
        return;
      }
      const objectMatch = requestUrl.pathname.match(/^\/storage\/v1\/object\/([^/]+)(?:\/(.+))?$/);
      if (objectMatch) {
        const bucket = decodeURIComponent(objectMatch[1]!);
        const objectPath = objectMatch[2] ? decodeURIComponent(objectMatch[2]) : "";
        const key = `${bucket}/${objectPath}`;
        if (request.method === "POST" && objectPath) {
          const body = await readFixtureRequestBody(request);
          if (storedObjects.has(key)) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end('{"message":"The resource already exists"}');
            return;
          }
          storedObjects.set(key, body);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ Key: key }));
          return;
        }
        if (request.method === "GET" && objectPath) {
          const body = storedObjects.get(key);
          if (!body) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end('{"message":"not found"}');
            return;
          }
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
          response.end(body);
          return;
        }
        if (request.method === "DELETE" && !objectPath) {
          const body = JSON.parse((await readFixtureRequestBody(request)).toString("utf8")) as { prefixes?: unknown };
          if (!Array.isArray(body.prefixes) || body.prefixes.some((value) => typeof value !== "string")) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end('{"message":"invalid prefixes"}');
            return;
          }
          for (const object of body.prefixes) storedObjects.delete(`${bucket}/${object}`);
          response.writeHead(200, { "content-type": "application/json" });
          response.end("[]");
          return;
        }
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.name : "fixture_error" }));
    });
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
    storedObjectPaths: () => Object.freeze([...storedObjects.keys()].sort()),
  });
}

function readFixtureRequestBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
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

function runProductionBuild(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
  hmacKey: string,
): void {
  const nextRoot = path.resolve(process.cwd(), ".next");
  const nextCache = path.resolve(nextRoot, "cache");
  if (!nextCache.startsWith(`${nextRoot}${path.sep}`)) {
    throw new Error("Refused to clear a Next.js cache outside the workspace build directory.");
  }
  rmSync(nextCache, { force: true, recursive: true });
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKey),
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
  hmacKeyA: string,
  hmacKeyB: string,
): Promise<void> {
  const baseEnvironment = productionEnvironment(databaseUrl, submissionDatabaseUrl, authentication.origin, hmacKeyA);
  const runningServer = await startBuiltNextServer(baseEnvironment, port, "wp08-render-primary");
  const { turnstileNonce } = runningServer;
  let restartFixture: RestartFixture | undefined;
  let policyRestartFixture: PolicyRestartFixture | undefined;

  try {
    await assertAnalyticsHttpBoundary(databaseUrl);
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
      'type="file"',
      "Photo purpose",
      "public display",
      "noindex",
    ]) assertIncludes(firstContributionForm.body, expected, `protected contribution form: ${expected}`);
    for (const formPath of ["/request-part", "/confirm-fit", "/submit-design"] as const) {
      const form = formPath === "/request-part" ? firstContributionForm : await request(formPath, 200);
      for (const forbiddenName of ["mediaFile", "mediaPurpose", "mediaOwnsOrPermission", "mediaPrivateStorage", "mediaDerivativeProcessing", "mediaPublicDisplay"]) {
        if (form.body.includes(`name="${forbiddenName}"`)) {
          throw new Error(`${formPath} exposed media-only field ${forbiddenName} to the strict text submission payload.`);
        }
      }
    }
    assertPrivateDataAbsent(firstContributionForm.body, "WP-08 contribution form HTML/flight");
    for (const path of ["/confirm-fit", "/submit-design", "/contribution-privacy"] as const) {
      const contributionPage = await request(path, 200);
      assertPrivateDataAbsent(contributionPage.body, `${path} HTML/flight`);
      assertIncludes(contributionPage.body, "noindex", `${path} robots metadata`);
    }

    const missingIdempotencyKey = randomUUID();
    const analyticsCountBeforeMissing = await analyticsEventCount(databaseUrl, "missing_part_submitted");
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
    await assertAnalyticsEventCount(
      databaseUrl,
      "missing_part_submitted",
      analyticsCountBeforeMissing + 1,
      "idempotent missing-part submission completion",
    );
    await uploadAndFinalizeHttpPhoto({
      clientIp: "203.0.113.42", databaseUrl, expireUploadCapabilityBeforeFinalize: true,
      idempotencyKey: missingIdempotencyKey.toUpperCase(), kind: "missing_part",
      purpose: "broken_part_context", receiptId: firstMissingReceipt, serverOutput: runningServer.output,
    });
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
    await assertPrivateMediaCleanupHttpRaces(databaseUrl, authentication, {
      finalize: { clientIp: "203.0.113.42", idempotencyKey: missingIdempotencyKey, receiptId: firstMissingReceipt },
      upload: { clientIp: "203.0.113.43", idempotencyKey: missingIdempotencyKey, receiptId: secondContributorReceipt },
    });
    const beforeHoneypot = await privateStateSnapshot(databaseUrl);
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
    assertPrivateStateUnchanged(
      beforeHoneypot,
      await privateStateSnapshot(databaseUrl),
      true,
      "opaque honeypot HTTP intake",
    );

    const designIdempotencyKey = randomUUID().toUpperCase();
    const designRequest = {
      brand: "WP08 HTTP fixture",
      claimedLicense: "NOT-STATED",
      componentName: "Dust-bin latch",
      contributionConsent: true,
      creatorName: "HTTP Fixture Creator",
      emailFollowUpConsent: false,
      idempotencyKey: designIdempotencyKey,
      modelNumber: "HTTP-100",
      notes: "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
      privacyConsent: true,
      sourceUrl: "https://example.invalid/wp08-http-design",
      website: "",
    };
    const firstDesignReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/designs",
      { ...designRequest, challengeToken: integrationToken(turnstileNonce, "design_submission") },
      "203.0.113.45",
      202,
    ), "design-submission HTTP intake");
    const retriedDesignReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/designs",
      { ...designRequest, challengeToken: integrationToken(turnstileNonce, "design_submission") },
      "203.0.113.45",
      202,
    ), "idempotent design-submission HTTP retry");
    if (retriedDesignReceipt !== firstDesignReceipt) {
      throw new Error("An idempotent design-submission HTTP retry did not return its original opaque receipt.");
    }
    await uploadAndFinalizeHttpPhoto({
      clientIp: "203.0.113.45", idempotencyKey: designIdempotencyKey.toLowerCase(), kind: "design_submission",
      purpose: "installed_fit", receiptId: firstDesignReceipt,
    });
    const designResponse = await postSubmission(
      "/api/v1/submissions/designs",
      {
        ...designRequest,
        challengeToken: integrationToken(turnstileNonce, "design_submission"),
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

    const fitIdempotencyKey = randomUUID();
    const fitRequest = {
      contributionConsent: true,
      designRevision: "r-http",
      email: "wp08-http-evidence@example.invalid",
      emailFollowUpConsent: true,
      evidenceUrl: "https://example.invalid/private-fit?token=WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
      idempotencyKey: fitIdempotencyKey,
      modelNumber: "HTTP-100",
      modificationNotes: "Printer stopped before fit could be tested.",
      outcome: "print_failed",
      partSlug: "wp08-http-latch",
      printSettings: "PETG",
      privacyConsent: true,
      website: "",
    };
    const fitToken = integrationToken(turnstileNonce, "fit_confirmation");
    const firstFitReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      {
        ...fitRequest,
        challengeToken: fitToken,
      },
      "203.0.113.46",
      202,
    ), "print-failed HTTP intake");
    const retriedFitReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      { ...fitRequest, challengeToken: integrationToken(turnstileNonce, "fit_confirmation") },
      "203.0.113.46",
      202,
    ), "idempotent fit-confirmation HTTP retry");
    if (retriedFitReceipt !== firstFitReceipt) {
      throw new Error("An idempotent fit-confirmation HTTP retry did not return its original opaque receipt.");
    }
    await uploadAndFinalizeHttpPhoto({
      clientIp: "203.0.113.46", idempotencyKey: fitIdempotencyKey, kind: "fit_confirmation",
      purpose: "model_label", receiptId: firstFitReceipt,
    });
    await assertHttpMediaPayloadIsolation(databaseUrl, [firstMissingReceipt, firstDesignReceipt, firstFitReceipt]);
    await assertAal2MediaReviewHttp(databaseUrl, authentication, firstMissingReceipt);
    await assertPrivateMediaCrashRecovery(databaseUrl, authentication);
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

    await runCorrectiveIdempotencyHttpAssertions(turnstileNonce);
    await runCanonicalUuidHttpAssertions(databaseUrl, turnstileNonce);
    await runConcurrentHttpOverlapAssertions(databaseUrl, turnstileNonce);
    await runHttpFailureInjectionAssertion(databaseUrl, turnstileNonce);
    await runCleanupAliasRaceAssertion(databaseUrl, submissionDatabaseUrl, turnstileNonce);
    await assertNoEphemeralSubmissionTestHooks(databaseUrl);
    restartFixture = await createRestartFixture(turnstileNonce);
    policyRestartFixture = await createPolicyRestartFixture(turnstileNonce);
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

    const globalRateRequest = {
      ...missingRequest,
      brand: "WP08 global rate fixture",
      emailFollowUpConsent: true,
      modelNumber: "GLOBAL-RATE-100",
      website: "",
    };
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await assertAcceptedJson(await postSubmission(
        "/api/v1/submissions/requests",
        {
          ...globalRateRequest,
          challengeToken: integrationToken(turnstileNonce, "missing_part"),
          email: `wp08-global-rate-${attempt}@example.invalid`,
          idempotencyKey: randomUUID(),
        },
        "203.0.113.49",
        202,
      ), `global rate-limit valid request ${attempt + 1}`);
    }
    const globalLimited = await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...globalRateRequest,
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
        email: "wp08-global-rate-limited@example.invalid",
        idempotencyKey: randomUUID(),
      },
      "203.0.113.49",
      429,
    );
    assertRateLimited(globalLimited, "global HTTP rate limit");

    const equivalentIpv6Spellings = ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"] as const;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await assertAcceptedJson(await postSubmission(
        "/api/v1/submissions/requests",
        {
          ...globalRateRequest,
          challengeToken: integrationToken(turnstileNonce, "missing_part"),
          email: `wp08-ipv6-rate-${attempt}@example.invalid`,
          idempotencyKey: randomUUID(),
          modelNumber: "IPV6-GLOBAL-RATE-100",
        },
        equivalentIpv6Spellings[attempt % equivalentIpv6Spellings.length]!,
        202,
      ), `equivalent-IPv6 rate identity request ${attempt + 1}`);
    }
    const equivalentIpv6Limited = await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...globalRateRequest,
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
        email: "wp08-ipv6-rate-limited@example.invalid",
        idempotencyKey: randomUUID(),
        modelNumber: "IPV6-GLOBAL-RATE-100",
      },
      equivalentIpv6Spellings[1],
      429,
    );
    assertRateLimited(equivalentIpv6Limited, "equivalent-IPv6 canonical HTTP rate identity");

    const submissionIds = await assertHttpSubmissionPersistence(databaseUrl);
    await assertPrivateEvidenceAuthorization(submissionIds, authentication);

    const model = await request("/brands/renderworks/rx-100", 200);
    assertIncludes(model.body, "RenderWorks RX-100 printable repair parts", "exact-model metadata title");
    assertIncludes(model.body, "RX-100", "accepted primary identifier");
    assertIncludes(model.body, "/brands/renderworks/rx-100", "exact-model canonical metadata");
    assertIncludes(model.body, "/parts/render-rx100-latch-r1", "eligible exact-model part link");
    assertExcludes(model.body, "WP07_UNCITED_ALIAS_SENTINEL", "uncited identifier in model HTML/flight");
    assertPrivateDataAbsent(model.body, "exact-model HTML/flight");
    assertReceiptDataAbsent(model.body, "exact-model HTML/flight");

    const emptyModel = await request("/brands/renderworks/rx-empty", 200);
    assertIncludes(emptyModel.body, "RX-EMPTY", "published empty exact-model page");
    assertIncludes(emptyModel.body, "noindex", "published empty exact-model robots metadata");
    assertPrivateDataAbsent(emptyModel.body, "published empty exact-model HTML/flight");
    const sitemap = await request("/sitemap.xml", 200);
    assertExcludes(sitemap.body, "/brands/renderworks/rx-empty", "published empty exact model in sitemap");
    assertExcludes(sitemap.body, "/parts/render-private-latch-r1", "unpublished part in sitemap");
    assertExcludes(sitemap.body, "/parts/render-removed-latch-r1", "unavailable part in sitemap");
    assertExcludes(sitemap.body, "/parts/render-rx-empty-disputed-r1", "disputed part in sitemap");
    assertExcludes(sitemap.body, "preview=1", "parameterized catalogue URL in sitemap");
    assertSitemapLastmod(sitemap.body, `${origin}/brands/renderworks/rx-100`, "2026-07-12");
    assertSitemapLastmod(sitemap.body, `${origin}/parts/render-rx100-latch-r1`, "2026-07-12");
    await mutatePrivateTimestamp(databaseUrl);
    const sitemapAfterPrivateMutation = await request("/sitemap.xml", 200);
    if (sitemapAfterPrivateMutation.body !== sitemap.body) {
      throw new Error("A private submission timestamp changed public sitemap URLs or lastmod values.");
    }
    await updateUnrenderedRevisionState(databaseUrl, "internal-only-source-hash", "2099-01-01T00:00:00.000Z");
    try {
      const sitemapAfterInternalMutation = await request("/sitemap.xml", 200);
      if (sitemapAfterInternalMutation.body !== sitemap.body) {
        throw new Error("An unrendered public-record field changed public sitemap URLs or lastmod values.");
      }
    } finally {
      await updateUnrenderedRevisionState(databaseUrl, null, "2026-07-12T06:00:00.000Z");
    }
    await updateVisiblePublicSourceCheck(databaseUrl, "2026-07-13T08:30:00.000Z");
    try {
      const sitemapAfterPublicMutation = await request("/sitemap.xml", 200);
      assertSitemapLastmod(
        sitemapAfterPublicMutation.body,
        `${origin}/parts/render-rx100-latch-r1`,
        "2026-07-13",
      );
      assertSitemapLastmod(
        sitemapAfterPublicMutation.body,
        `${origin}/brands/renderworks/rx-100`,
        "2026-07-13",
      );
    } finally {
      await updateVisiblePublicSourceCheck(databaseUrl, "2026-07-12T06:00:00.000Z");
    }
    const sitemapAfterPublicRestore = await request("/sitemap.xml", 200);
    assertSitemapLastmod(sitemapAfterPublicRestore.body, `${origin}/parts/render-rx100-latch-r1`, "2026-07-12");
    assertSitemapLastmod(sitemapAfterPublicRestore.body, `${origin}/brands/renderworks/rx-100`, "2026-07-12");

    const parameterizedPart = await fetch(`${origin}/parts/render-rx100-latch-r1?preview=1`, { redirect: "manual" });
    const parameterizedPartBody = await parameterizedPart.text();
    if (parameterizedPart.status !== 200) {
      throw new Error(`Parameterized canonical part returned ${parameterizedPart.status}, expected 200.`);
    }
    const parameterizedRobots = parameterizedPart.headers.get("x-robots-tag") ?? "";
    if (!parameterizedRobots.includes("noindex") || !parameterizedRobots.includes("follow") || parameterizedRobots.includes("nofollow")) {
      throw new Error("Parameterized canonical part omitted its noindex, follow HTTP boundary.");
    }
    assertSingleCanonical(parameterizedPartBody, `${origin}/parts/render-rx100-latch-r1`, "parameterized part canonical");
    assertPrivateDataAbsent(parameterizedPartBody, "parameterized canonical part HTML/flight");

    const part = await request("/parts/render-rx100-latch-r1", 200);
    for (const expected of [
      "Dust-bin latch printable replacement",
      "RenderWorks RX-100 latch",
      "RenderWorks RX-100",
      "Bin clip",
      "OEM-RX-100",
      "Alias source",
      "OEM source",
      "Creator listed",
      "CC-BY-4.0",
      "Creator cites the exact RX-100 and r1 design revision.",
      "PETG",
      "Low-risk v0 boundary",
      "https://render.example/designs/live-latch",
    ]) assertIncludes(part.body, expected, `canonical part content: ${expected}`);
    assertIncludes(part.body, "<dt>Revision</dt><dd>r1</dd>", "canonical part exact revision field");
    assertPrivateDataAbsent(part.body, "canonical part HTML/flight");
    assertReceiptDataAbsent(part.body, "canonical part HTML/flight");

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
    assertReceiptDataAbsent(flightBody, "direct React server payload");

    const tombstone = await request("/parts/render-removed-latch-r1", 200);
    assertIncludes(tombstone.body, "Source unavailable", "removed-source heading");
    assertIncludes(tombstone.body, "noindex", "removed-source robots metadata");
    assertExcludes(tombstone.body, "https://render.example/designs/removed-latch", "removed source URL");
    assertExcludes(tombstone.body, "Open original source", "removed source action");
    assertPrivateDataAbsent(tombstone.body, "removed-source HTML/flight");
    assertReceiptDataAbsent(tombstone.body, "removed-source HTML/flight");

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
    await assertNotFound("/parts/render-rx-empty-disputed-r1");
    await assertNotFound("/parts/render-archived-destination-history");
    await assertNotFound("/parts/render-archived-ineligible-r0");
    for (let index = 0; index < hostileRedirectDestinations.length; index += 1) {
      await assertNotFound(`/parts/render-hostile-${String(index + 1).padStart(2, "0")}`);
    }
    await assertNotFound("/parts/unknown-render-fitment");
    await assertNotFound("/brands/demovac/dv-100");
    await assertSourceAdministrationHttp(authentication);
    assertClientBundleSafe();
    await restoreWp11PublicMaterialFixtureDates(databaseUrl);
    runWp11ProductionHttpGates(runningServer.origin);

    console.log("Production render checks passed: production HTTP submissions, aggregate analytics, SEO, structured data, accessibility, performance, staff authorization, catalogue, and privacy boundaries are valid.");
  } finally {
    await stopBuiltNextServer(runningServer);
    assertPrivateDataAbsent(runningServer.output(), "production Next.js process output");
    assertReceiptDataAbsent(runningServer.output(), "production Next.js process output");
  }
  await runDemoSitemapHttpGate(baseEnvironment);
  if (!restartFixture) throw new Error("Production restart fixture was not completed.");
  if (!policyRestartFixture) throw new Error("Production policy-restart fixture was not completed.");
  await clearSubmissionRateLimits(databaseUrl);
  await assertKeyChangeAndApplicationRestart(
    databaseUrl,
    submissionDatabaseUrl,
    authentication.origin,
    hmacKeyA,
    hmacKeyB,
    restartFixture,
    policyRestartFixture,
    runningServer.pid,
  );
}

async function assertAnalyticsHttpBoundary(databaseUrl: string): Promise<void> {
  const eventName = "part_viewed";
  const before = await analyticsEventCount(databaseUrl, eventName);
  const accepted = await postAnalyticsEvent({
    name: eventName,
    properties: {
      confidenceTier: "creator_listed",
      publicId: "fit_render_live_r1",
      safetyClass: "low",
    },
  }, 202);
  if (accepted.body !== '{"accepted":true}') {
    throw new Error(`Built analytics endpoint returned an unexpected acceptance shape: ${accepted.body}.`);
  }
  await assertAnalyticsEventCount(databaseUrl, eventName, before + 1, "safe aggregate browser event");

  const sensitive = await postAnalyticsEvent({
    name: "search_submitted",
    properties: {
      identifierLike: true,
      normalizedCategory: "identifier",
      queryLength: 12,
      rawQuery: "WP11_ANALYTICS_RAW_QUERY_SENTINEL",
    },
  }, 400);
  assertAnalyticsError(sensitive.body, "INVALID_ANALYTICS_EVENT", "sensitive analytics property rejection");
  assertPrivateDataAbsent(sensitive.body, "sensitive analytics property rejection");

  const unknown = await postAnalyticsEvent({
    name: "session_identified",
    properties: { email: "wp11-analytics-private@example.invalid" },
  }, 400);
  assertAnalyticsError(unknown.body, "INVALID_ANALYTICS_EVENT", "unknown analytics event rejection");
  assertPrivateDataAbsent(unknown.body, "unknown analytics event rejection");

  const wrongOrigin = await postAnalyticsEvent({
    name: "variant_selected",
    properties: { selectedRank: 1 },
  }, 403, "https://analytics-attacker.example.invalid");
  assertAnalyticsError(wrongOrigin.body, "ANALYTICS_ORIGIN_FORBIDDEN", "cross-origin analytics rejection");

  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [leak] = await owner<{ leaked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM public.private_analytics_daily_aggregates
        WHERE dimensions::text LIKE '%WP11_ANALYTICS_RAW_QUERY_SENTINEL%'
           OR dimensions::text LIKE '%wp11-analytics-private@example.invalid%'
      ) AS leaked
    `;
    if (leak?.leaked) throw new Error("Rejected analytics request values entered private aggregates.");
  } finally {
    await owner.end();
  }
}

async function postAnalyticsEvent(
  payload: Readonly<Record<string, unknown>>,
  expectedStatus: number,
  requestOrigin = origin,
): Promise<HttpResponse> {
  const response = await fetch(`${origin}/api/v1/analytics/events`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: requestOrigin,
    },
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Built analytics endpoint returned ${response.status}, expected ${expectedStatus}. Body: ${body.slice(0, 500)}`);
  }
  assertPrivateResponseHeaders(response.headers, "built analytics endpoint");
  return Object.freeze({ body, headers: response.headers, status: response.status });
}

function assertAnalyticsError(body: string, expectedCode: string, label: string): void {
  const parsed = JSON.parse(body) as { error?: { code?: unknown } };
  if (
    parsed.error?.code !== expectedCode
    || Object.keys(parsed).join(",") !== "error"
    || Object.keys(parsed.error).join(",") !== "code"
  ) {
    throw new Error(`${label} returned an unsafe error shape: ${body}.`);
  }
}

async function analyticsEventCount(databaseUrl: string, eventName: string): Promise<number> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [aggregate] = await owner<{ eventCount: number }[]>`
      SELECT COALESCE(sum(event_count), 0)::int AS "eventCount"
      FROM public.private_analytics_daily_aggregates
      WHERE event_name = ${eventName}
    `;
    return aggregate?.eventCount ?? 0;
  } finally {
    await owner.end();
  }
}

async function mutatePrivateTimestamp(databaseUrl: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner`
      UPDATE public.submissions
      SET updated_at = '2099-01-01T00:00:00.000Z'::timestamptz
      WHERE id = ${ids.privateSubmission}
    `;
  } finally {
    await owner.end();
  }
}

async function restoreWp11PublicMaterialFixtureDates(databaseUrl: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const fixtureTimestamp = "2026-07-12T06:00:00.000Z";
  try {
    await owner`
      UPDATE public.sources
      SET retrieved_at = ${fixtureTimestamp}::timestamptz,
          last_checked_at = ${fixtureTimestamp}::timestamptz
      WHERE id IN (${ids.liveSource}, ${ids.removedSource}, ${ids.draftSource})
    `;
  } finally {
    await owner.end();
  }
}

async function updateUnrenderedRevisionState(
  databaseUrl: string,
  sourceHash: string | null,
  updatedAt: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner`
      UPDATE public.design_revisions
      SET source_hash = ${sourceHash}, updated_at = ${updatedAt}::timestamptz
      WHERE id = ${ids.liveRevision}
    `;
  } finally {
    await owner.end();
  }
}

async function updateVisiblePublicSourceCheck(
  databaseUrl: string,
  lastCheckedAt: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner`
      UPDATE public.sources
      SET last_checked_at = ${lastCheckedAt}::timestamptz
      WHERE id = ${ids.liveSource}
    `;
  } finally {
    await owner.end();
  }
}

async function assertAnalyticsEventCount(
  databaseUrl: string,
  eventName: string,
  expectedCount: number,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const actual = await analyticsEventCount(databaseUrl, eventName);
    if (actual === expectedCount) return;
    if (actual > expectedCount) {
      throw new Error(`${label} incremented ${eventName} more than once: expected ${expectedCount}, found ${actual}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const actual = await analyticsEventCount(databaseUrl, eventName);
  throw new Error(`${label} did not persist exactly one aggregate event: expected ${expectedCount}, found ${actual}.`);
}

function runWp11ProductionHttpGates(serverOrigin: string): void {
  const commonEnvironment = {
    CI: "true",
    NO_COLOR: "1",
    WP11_BASE_URL: serverOrigin,
    WP11_CANONICAL_ORIGIN: origin,
    WP11_EXPECT_DEMO: "false",
  };
  runNodeGate(
    "production sitemap/canonical/indexability HTTP audit",
    ["--import", "tsx", path.join("scripts", "check-sitemap-http.ts")],
    commonEnvironment,
  );
  for (const [label, spec] of [
    ["aggregate analytics browser audit", "wp11-analytics.spec.ts"],
    ["structured-data HTTP audit", "wp11-structured-data.spec.ts"],
    ["WCAG 2.2 A/AA browser audit", "wp11-accessibility.spec.ts"],
    ["performance budget browser audit", "wp11-performance.spec.ts"],
  ] as const) {
    runNodeGate(
      label,
      [path.join("node_modules", "@playwright", "test", "cli.js"), "test", path.posix.join("tests", "browser", spec)],
      commonEnvironment,
    );
  }
}

async function runDemoSitemapHttpGate(baseEnvironment: NodeJS.ProcessEnv): Promise<void> {
  const demoOrigin = `http://127.0.0.1:${demoPort}`;
  const demoServer = await startBuiltNextServer({
    ...baseEnvironment,
    DEMO_MODE: "true",
    NEXT_PUBLIC_SITE_URL: demoOrigin,
    REPAIRPRINT_DEPLOYMENT_ENV: "preview",
  }, demoPort, "wp11-render-demo");
  try {
    runNodeGate(
      "demo sitemap/crawler-lock HTTP audit",
      ["--import", "tsx", path.join("scripts", "check-sitemap-http.ts")],
      {
        CI: "true",
        NO_COLOR: "1",
        WP11_BASE_URL: demoOrigin,
        WP11_CANONICAL_ORIGIN: demoOrigin,
        WP11_EXPECT_DEMO: "true",
      },
    );
    for (const [pathname, expectedStatus] of [
      ["/", 200],
      ["/methodology", 200],
      ["/brands/renderworks/rx-100", 404],
      ["/search?q=RX-100", 200],
    ] as const) {
      const response = await fetch(`${demoOrigin}${pathname}`, { redirect: "manual" });
      if (response.status !== expectedStatus) {
        throw new Error(`Demo runtime ${pathname} returned ${response.status}, expected ${expectedStatus}.`);
      }
      const robots = response.headers.get("x-robots-tag") ?? "";
      if (!robots.includes("noindex") || !robots.includes("nofollow")) {
        throw new Error(`Demo runtime ${pathname} omitted its noindex, nofollow X-Robots-Tag boundary.`);
      }
    }
  } finally {
    await stopBuiltNextServer(demoServer);
    assertPrivateDataAbsent(demoServer.output(), "demo Next.js process output");
    assertReceiptDataAbsent(demoServer.output(), "demo Next.js process output");
  }
}

function runNodeGate(
  label: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): void {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit status ${result.status ?? "unknown"}.`);
}

function productionEnvironment(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
  hmacKey: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANALYTICS_DATABASE_URL: analyticsDatabaseUrlForRender,
    ANALYTICS_MODE: "aggregate_database",
    DATABASE_URL: databaseUrl,
    DEMO_MODE: "false",
    NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: origin,
    NOTICE_CONTACT_URL: "https://notices.example.invalid/report",
    REPAIRPRINT_DEPLOYMENT_ENV: "production",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    NEXT_TELEMETRY_DISABLED: "1",
    SUBMISSION_CONTACT_RETENTION_DAYS: "30",
    SUBMISSION_DATABASE_URL: submissionDatabaseUrl,
    SUBMISSION_HMAC_SECRET: hmacKey,
    SUBMISSION_RETENTION_DAYS: "90",
    SUBMISSION_RETENTION_POLICY_VERSION: "wp08-render-retention-v1",
    MEDIA_CAPABILITY_SECRET: "6d6f2cffd13b8a5fd7cb9a66963cac91ce989326e0bd22eebe3f434469efb38f",
    MEDIA_PRIVATE_BUCKET: "wp09-render-private",
    MEDIA_PRIVACY_VERSION: "wp09-render-privacy-v1",
    MEDIA_QUARANTINE_BUCKET: "wp09-render-quarantine",
    MEDIA_RETENTION_DAYS: "30",
    MEDIA_RETENTION_POLICY_VERSION: "wp09-render-retention-v1",
    MEDIA_TERMS_VERSION: "wp09-render-terms-v1",
    SOURCE_ADAPTER_MODE: "disabled",
    SOURCE_DATABASE_URL: sourceDatabaseUrlForRender,
    SOURCE_LINK_WORKER_ACTOR_ID: ids.adminStaff,
    SOURCE_LINK_WORKER_ID: "wp10-render-worker",
    SOURCE_LINK_WORKER_SECRET: sourceWorkerSecret,
    SUPABASE_URL: authenticationOrigin,
    SUPABASE_SERVICE_ROLE_KEY: "WP09_STORAGE_SERVICE_KEY_SENTINEL",
    TURNSTILE_SECRET_KEY: testTurnstileSecret,
  };
}

type PrivateStateSnapshot = Readonly<{
  contacts: number;
  followUps: number;
  intakes: number;
  orphanIntakes: number;
  rateCount: number;
  rateRows: number;
  receipts: number;
  submissions: number;
}>;

async function provisionSubmissionKeyPin(
  databaseUrl: string,
  hmacKey: string,
  hmacVersion = SUBMISSION_HMAC_ALGORITHM_VERSION,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const commitment = deriveSubmissionHmacKeyCommitment(hmacKey, hmacVersion);
    await owner.begin(async (transaction) => {
      await transaction`LOCK TABLE public.submission_hmac_key_pin IN ACCESS EXCLUSIVE MODE`;
      await transaction`DELETE FROM public.submission_hmac_key_pin WHERE singleton = true`;
      await transaction`
        INSERT INTO public.submission_hmac_key_pin (singleton, hmac_version, key_commitment)
        VALUES (true, ${hmacVersion}, ${commitment})
      `;
    });
  } finally {
    await owner.end();
  }
}

type ProvisioningCommandResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
}>;

type RunningProvisioningCommand = Readonly<{
  child: ChildProcess;
  completion: Promise<ProvisioningCommandResult>;
  output: () => string;
}>;

function runSubmissionKeyPinProvisioningCommand(
  databaseUrl: string,
  hmacKey: string,
  replace: boolean,
): ProvisioningCommandResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/provision-submission-hmac-key-pin.ts", ...(replace ? ["--replace"] : [])],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DEMO_MODE: "false",
        SUBMISSION_HMAC_SECRET: hmacKey,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  return Object.freeze({ status: result.status, stderr: result.stderr, stdout: result.stdout });
}

function startSubmissionKeyPinProvisioningCommand(
  databaseUrl: string,
  hmacKey: string,
  replace: boolean,
): RunningProvisioningCommand {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/provision-submission-hmac-key-pin.ts", ...(replace ? ["--replace"] : [])],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DEMO_MODE: "false",
        SUBMISSION_HMAC_SECRET: hmacKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const completion = new Promise<ProvisioningCommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(Object.freeze({ status, stderr, stdout })));
  });
  return Object.freeze({ child, completion, output: () => `${stdout}${stderr}` });
}

async function assertSubmissionKeyPinProvisioningUtility(
  databaseUrl: string,
  hmacKeyA: string,
  hmacKeyB: string,
): Promise<void> {
  const baseline = await privateStateSnapshot(databaseUrl);
  const unchanged = runSubmissionKeyPinProvisioningCommand(databaseUrl, hmacKeyA, false);
  if (unchanged.status !== 0
    || unchanged.stderr.trim() !== ""
    || unchanged.stdout.trim() !== JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_READY", outcome: "unchanged" })) {
    throw new Error("Same-key pin provisioning did not return the safe unchanged result.");
  }

  for (const [label, result] of [
    ["mismatched key", runSubmissionKeyPinProvisioningCommand(databaseUrl, hmacKeyB, false)],
    ["retained-data replacement", runSubmissionKeyPinProvisioningCommand(databaseUrl, hmacKeyB, true)],
  ] as const) {
    if (result.status === 0
      || result.stdout.trim() !== ""
      || result.stderr.trim() !== JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_FAILED" })) {
      throw new Error(`${label} pin provisioning did not fail with the safe generic contract.`);
    }
  }

  for (const output of [unchanged.stdout, unchanged.stderr]) {
    assertPrivateDataAbsent(output, "submission HMAC key-pin provisioning output");
  }
  assertPrivateStateUnchanged(
    baseline,
    await privateStateSnapshot(databaseUrl),
    true,
    "submission HMAC key-pin provisioning utility",
  );
  await assertStoredSubmissionKeyPin(databaseUrl, hmacKeyA);
}

async function assertStoredSubmissionKeyPin(databaseUrl: string, hmacKey: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [pin] = await owner<{ hmacVersion: string; keyCommitment: string }[]>`
      SELECT hmac_version AS "hmacVersion", key_commitment AS "keyCommitment"
      FROM public.submission_hmac_key_pin
      WHERE singleton = true
    `;
    if (!pin
      || pin.hmacVersion !== SUBMISSION_HMAC_ALGORITHM_VERSION
      || pin.keyCommitment !== deriveSubmissionHmacKeyCommitment(hmacKey)) {
      throw new Error("Stored submission HMAC key pin did not match the expected key/version.");
    }
  } finally {
    await owner.end();
  }
}

async function assertKeyPinFailureModes(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
  hmacKey: string,
): Promise<void> {
  const pinOwner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await pinOwner`DELETE FROM public.submission_hmac_key_pin WHERE singleton = true`;
  } finally {
    await pinOwner.end();
  }
  const fixture = {
    brand: "WP08 key-pin fixture",
    brokenPart: "Private latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey: randomUUID(),
    modelNumber: "WP08-PIN-FAIL-CLOSED",
    notes: "WP08_KEY_PIN_PRIVATE_SENTINEL",
    privacyConsent: true,
    website: "",
  };
  const baseline = await privateStateSnapshot(databaseUrl);

  const missingRetainedProvision = runSubmissionKeyPinProvisioningCommand(databaseUrl, hmacKey, false);
  if (missingRetainedProvision.status === 0
    || missingRetainedProvision.stdout.trim() !== ""
    || missingRetainedProvision.stderr.trim() !== JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_FAILED" })) {
    throw new Error("Missing-pin provisioning with retained data did not fail safely.");
  }
  assertPrivateDataAbsent(missingRetainedProvision.stderr, "missing-pin retained-data provisioning output");
  assertPrivateStateUnchanged(
    baseline,
    await privateStateSnapshot(databaseUrl),
    true,
    "missing-pin retained-data provisioning",
  );
  const missingPinOwner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [pinState] = await missingPinOwner<{ pins: number }[]>`
      SELECT count(*)::int AS pins FROM public.submission_hmac_key_pin
    `;
    if (!pinState || pinState.pins !== 0) throw new Error("Failed missing-pin provisioning unexpectedly installed a pin.");
  } finally {
    await missingPinOwner.end();
  }

  const missingPinServer = await startBuiltNextServer(
    productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKey),
    port,
    "wp08-pin-missing",
  );
  try {
    const failure = await postSubmission(
      "/api/v1/submissions/requests",
      { ...fixture, challengeToken: integrationToken(missingPinServer.turnstileNonce, "missing_part") },
      "203.0.113.91",
      503,
    );
    assertPrivateError(failure, "SUBMISSION_UNAVAILABLE", "missing HMAC key pin");
  } finally {
    await stopBuiltNextServer(missingPinServer);
    assertPrivateDataAbsent(missingPinServer.output(), "missing-pin Next.js process output");
  }
  assertPrivateStateUnchanged(baseline, await privateStateSnapshot(databaseUrl), true, "missing HMAC key pin");

  const wrongVersion = "hmac-sha256/test-incompatible-v999";
  await provisionSubmissionKeyPin(databaseUrl, hmacKey, wrongVersion);
  const wrongVersionServer = await startBuiltNextServer(
    productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKey),
    port,
    "wp08-pin-version-mismatch",
  );
  try {
    const failure = await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...fixture,
        challengeToken: integrationToken(wrongVersionServer.turnstileNonce, "missing_part"),
        idempotencyKey: randomUUID(),
      },
      "203.0.113.92",
      503,
    );
    assertPrivateError(failure, "SUBMISSION_UNAVAILABLE", "mismatched HMAC key-pin version");
  } finally {
    await stopBuiltNextServer(wrongVersionServer);
    assertPrivateDataAbsent(wrongVersionServer.output(), "wrong-version-pin Next.js process output");
  }
  assertPrivateStateUnchanged(baseline, await privateStateSnapshot(databaseUrl), true, "mismatched HMAC key-pin version");

  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner`DELETE FROM public.submission_hmac_key_pin WHERE singleton = true`;
  } finally {
    await owner.end();
  }
}

async function privateStateSnapshot(databaseUrl: string): Promise<PrivateStateSnapshot> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [state] = await owner<PrivateStateSnapshot[]>`
      SELECT
        (SELECT count(*)::int FROM public.submissions WHERE intake_version = 1) AS submissions,
        (SELECT count(*)::int FROM public.submission_idempotency_bindings) AS intakes,
        (SELECT count(DISTINCT receipt_id)::int FROM public.submissions WHERE intake_version = 1) AS receipts,
        (SELECT count(*)::int FROM public.submission_intake_contacts) AS contacts,
        (SELECT count(*)::int FROM public.submission_email_follow_ups) AS "followUps",
        (SELECT count(*)::int FROM public.submission_rate_limit_buckets) AS "rateRows",
        (SELECT COALESCE(sum(request_count), 0)::int FROM public.submission_rate_limit_buckets) AS "rateCount",
        (SELECT count(*)::int
          FROM public.submission_idempotency_bindings AS intake
          LEFT JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.id IS NULL) AS "orphanIntakes"
    `;
    if (!state) throw new Error("Private-state snapshot returned no row.");
    return Object.freeze(state);
  } finally {
    await owner.end();
  }
}

function assertPrivateStateUnchanged(
  before: PrivateStateSnapshot,
  after: PrivateStateSnapshot,
  includeRates: boolean,
  label: string,
): void {
  const fields: readonly (keyof PrivateStateSnapshot)[] = includeRates
    ? ["submissions", "intakes", "receipts", "contacts", "followUps", "orphanIntakes", "rateRows", "rateCount"]
    : ["submissions", "intakes", "receipts", "contacts", "followUps", "orphanIntakes"];
  if (fields.some((field) => before[field] !== after[field])) {
    throw new Error(`${label} changed private persistence counts.`);
  }
}

async function clearSubmissionRateLimits(databaseUrl: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner`DELETE FROM public.submission_rate_limit_buckets`;
  } finally {
    await owner.end();
  }
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
  const response = await postSubmissionUnchecked(pathname, payload, clientIp, encoding);
  if (response.status !== expectedStatus) {
    throw new Error(`${pathname} returned ${response.status}, expected ${expectedStatus}.`);
  }
  return response;
}

async function postSubmissionUnchecked(
  pathname: string,
  payload: Record<string, unknown>,
  clientIp: string,
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
  assertPrivateResponseHeaders(response.headers, pathname);
  if (response.status !== 200) assertPrivateDataAbsent(responseBody, `${pathname} HTTP response`);
  return Object.freeze({ body: responseBody, headers: response.headers, status: response.status });
}

async function uploadAndFinalizeHttpPhoto(input: Readonly<{
  clientIp: string;
  databaseUrl?: string;
  expireUploadCapabilityBeforeFinalize?: boolean;
  idempotencyKey: string;
  kind: "missing_part" | "fit_confirmation" | "design_submission";
  purpose: "model_label" | "installed_fit" | "broken_part_context";
  receiptId: string;
  serverOutput?: () => string;
}>): Promise<void> {
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 20, g: 80, b: 120 } } })
    .jpeg({ quality: 85 }).toBuffer();
  const sessionResponse = await fetch(`${origin}/api/v1/private-media/sessions`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Origin: origin, "X-Vercel-Forwarded-For": input.clientIp },
    body: JSON.stringify({
      idempotencyKey: input.idempotencyKey, receiptId: input.receiptId, kind: input.kind, purpose: input.purpose,
      claimedBytes: bytes.length, claimedMimeType: "image/jpeg", claimedExtension: "jpg",
      ownsOrHasPermission: true, privateStorage: true, derivativeProcessing: true, publicDisplay: false,
      termsVersion: "wp09-render-terms-v1", privacyVersion: "wp09-render-privacy-v1", retentionVersion: "wp09-render-retention-v1",
    }),
  });
  const sessionBody = await sessionResponse.json() as Record<string, unknown>;
  if (sessionResponse.status !== 201 || typeof sessionBody.mediaId !== "string" || typeof sessionBody.uploadCapability !== "string") {
    const diagnostic = input.serverOutput ? sanitizedMediaDiagnostic(input.serverOutput()) : "none";
    throw new Error(`Real HTTP ${input.kind} photo session failed safely: ${sessionResponse.status} ${JSON.stringify(sessionBody)}; diagnostic=${diagnostic}.`);
  }
  assertPrivateResponseHeaders(sessionResponse.headers, `${input.kind} media session`);
  const uploadResponse = await fetch(`${origin}/api/v1/private-media/${sessionBody.mediaId}/upload`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${sessionBody.uploadCapability}`, "Content-Length": String(bytes.length), "Content-Type": "image/jpeg" },
    body: bytes,
  });
  const uploadBody = await uploadResponse.json() as Record<string, unknown>;
  if (uploadResponse.status !== 200 || uploadBody.status !== "uploaded" || typeof uploadBody.finalizeCapability !== "string") {
    const diagnostic = input.serverOutput ? sanitizedMediaDiagnostic(input.serverOutput()) : "none";
    throw new Error(`Real HTTP ${input.kind} photo upload failed safely: ${uploadResponse.status} ${JSON.stringify(uploadBody)}; diagnostic=${diagnostic}.`);
  }
  assertPrivateResponseHeaders(uploadResponse.headers, `${input.kind} media upload`);
  if (input.expireUploadCapabilityBeforeFinalize) {
    if (!input.databaseUrl) throw new Error("Upload-capability expiry assertion requires the database URL.");
    const owner = postgres(input.databaseUrl, { prepare: false, max: 1 });
    try {
      await owner`UPDATE public.private_media_upload_sessions SET capability_expires_at = pg_catalog.clock_timestamp() - interval '1 minute' WHERE public_id = ${sessionBody.mediaId}`;
    } finally { await owner.end(); }
  }
  const finalizeResponse = await fetch(`${origin}/api/v1/private-media/${sessionBody.mediaId}/finalize`, {
    method: "POST", headers: { Authorization: `Bearer ${uploadBody.finalizeCapability}` },
  });
  const finalizeBody = await finalizeResponse.json() as Record<string, unknown>;
  if (finalizeResponse.status !== 200 || finalizeBody.status !== "processed") {
    const diagnostic = input.serverOutput ? sanitizedMediaDiagnostic(input.serverOutput()) : "none";
    throw new Error(`Real HTTP ${input.kind} photo finalization failed safely: ${finalizeResponse.status} ${JSON.stringify(finalizeBody)}; diagnostic=${diagnostic}.`);
  }
  assertPrivateResponseHeaders(finalizeResponse.headers, `${input.kind} media finalize`);
}

function sanitizedMediaDiagnostic(output: string): string {
  const internalCodes = [...output.matchAll(/internalCode:\s*['\"]([A-Z0-9_]+)['\"]/g)].map((match) => match[1]);
  const databaseCodes = [...output.matchAll(/databaseCode:\s*['\"]([0-9A-Z]{5})['\"]/g)].map((match) => match[1]);
  const databaseFailureClasses = [...output.matchAll(/databaseFailureClass:\s*['\"]([A-Z0-9_]+)['\"]/g)].map((match) => match[1]);
  const failureKinds = [...output.matchAll(/failureKind:\s*['\"]([A-Za-z]+)['\"]/g)].map((match) => match[1]);
  const failureChains = [...output.matchAll(/failureChain:\s*\[\s*([^\]]+)\]/g)].map((match) => match[1]?.replaceAll(/[^A-Za-z,' ]/g, ""));
  return JSON.stringify({ databaseCode: databaseCodes.at(-1), databaseFailureClass: databaseFailureClasses.at(-1), failureChain: failureChains.at(-1), failureKind: failureKinds.at(-1), internalCode: internalCodes.at(-1) });
}

async function assertPrivateMediaCleanupHttpRaces(
  databaseUrl: string,
  authentication: AuthenticationFixture,
  fixtures: Readonly<{
    finalize: Readonly<{ clientIp: string; idempotencyKey: string; receiptId: string }>;
    upload: Readonly<{ clientIp: string; idempotencyKey: string; receiptId: string }>;
  }>,
): Promise<void> {
  const baselinePaths = authentication.storedObjectPaths();
  const bytes = await sharp({ create: { width: 24, height: 18, channels: 3, background: { r: 90, g: 30, b: 20 } } }).jpeg().toBuffer();
  const createSession = async (fixture: typeof fixtures.upload, purpose: "model_label" | "installed_fit") => {
    const response = await fetch(`${origin}/api/v1/private-media/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "X-Vercel-Forwarded-For": fixture.clientIp },
      body: JSON.stringify({
        idempotencyKey: fixture.idempotencyKey, receiptId: fixture.receiptId, kind: "missing_part", purpose,
        claimedBytes: bytes.length, claimedMimeType: "image/jpeg", claimedExtension: "jpg",
        ownsOrHasPermission: true, privateStorage: true, derivativeProcessing: true, publicDisplay: false,
        termsVersion: "wp09-render-terms-v1", privacyVersion: "wp09-render-privacy-v1", retentionVersion: "wp09-render-retention-v1",
      }),
    });
    const body = await response.json() as { mediaId?: string; uploadCapability?: string };
    if (response.status !== 201 || !body.mediaId || !body.uploadCapability) throw new Error(`Cleanup-race media session failed: ${response.status} ${JSON.stringify(body)}.`);
    return { mediaId: body.mediaId, uploadCapability: body.uploadCapability };
  };
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const upload = await createSession(fixtures.upload, "installed_fit");
    await owner`UPDATE public.private_media_upload_sessions SET capability_expires_at = pg_catalog.clock_timestamp() - interval '1 second' WHERE public_id = ${upload.mediaId}`;
    const uploadLease = randomUUID();
    const [uploadClaim] = await owner<{ path: string; sessionId: string }[]>`
      SELECT session_id AS "sessionId", quarantine_object_path AS path FROM public.claim_expired_private_media(1, ${uploadLease})
    `;
    if (!uploadClaim) throw new Error("Upload cleanup race could not acquire its lease.");
    const uploadResponse = await fetch(`${origin}/api/v1/private-media/${upload.mediaId}/upload`, {
      method: "PUT", headers: { Authorization: `Bearer ${upload.uploadCapability}`, "Content-Length": String(bytes.length), "Content-Type": "image/jpeg" }, body: bytes,
    });
    if (uploadResponse.status !== 400 || !JSON.stringify(await uploadResponse.json()).includes("MEDIA_UPLOAD_NOT_AVAILABLE")) {
      throw new Error("An active cleanup lease did not stop the real HTTP upload transition.");
    }
    if (authentication.storedObjectPaths().some((value) => value.endsWith(uploadClaim.path))) {
      throw new Error("Losing upload race left a quarantine object behind.");
    }
    await owner`SELECT * FROM public.complete_private_media_cleanup(${uploadLease}, ARRAY[${uploadClaim.sessionId}]::uuid[])`;

    const finalize = await createSession(fixtures.finalize, "model_label");
    const uploadResponse2 = await fetch(`${origin}/api/v1/private-media/${finalize.mediaId}/upload`, {
      method: "PUT", headers: { Authorization: `Bearer ${finalize.uploadCapability}`, "Content-Length": String(bytes.length), "Content-Type": "image/jpeg" }, body: bytes,
    });
    const uploaded = await uploadResponse2.json() as { finalizeCapability?: string };
    if (uploadResponse2.status !== 200 || !uploaded.finalizeCapability) throw new Error("Finalize cleanup-race upload failed.");
    await owner`UPDATE public.private_media_upload_sessions SET finalize_capability_expires_at = pg_catalog.clock_timestamp() - interval '1 second' WHERE public_id = ${finalize.mediaId}`;
    const finalizeLease = randomUUID();
    const [finalizeClaim] = await owner<{ path: string; sessionId: string }[]>`
      SELECT session_id AS "sessionId", quarantine_object_path AS path FROM public.claim_expired_private_media(1, ${finalizeLease})
    `;
    if (!finalizeClaim) throw new Error("Finalize cleanup race could not acquire its lease.");
    const finalizeResponse = await fetch(`${origin}/api/v1/private-media/${finalize.mediaId}/finalize`, {
      method: "POST", headers: { Authorization: `Bearer ${uploaded.finalizeCapability}` },
    });
    if (finalizeResponse.status !== 400 || !JSON.stringify(await finalizeResponse.json()).includes("MEDIA_FINALIZE_NOT_AVAILABLE")) {
      throw new Error("An active cleanup lease did not stop the real HTTP finalize transition.");
    }
    const remove = await fetch(`${authentication.origin}/storage/v1/object/wp09-render-quarantine`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [finalizeClaim.path] }),
    });
    if (!remove.ok) throw new Error("Cleanup-race fixture could not remove its quarantine object.");
    await owner`SELECT * FROM public.complete_private_media_cleanup(${finalizeLease}, ARRAY[${finalizeClaim.sessionId}]::uuid[])`;
    const [residue] = await owner<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public.private_media_upload_sessions WHERE public_id IN (${upload.mediaId}, ${finalize.mediaId})
    `;
    if (residue?.count !== 0 || JSON.stringify(authentication.storedObjectPaths()) !== JSON.stringify(baselinePaths)) {
      throw new Error(`Real cleanup races left media objects or rows: ${JSON.stringify({ paths: authentication.storedObjectPaths(), residue })}.`);
    }
  } finally { await owner.end(); }
}

async function assertPrivateMediaCrashRecovery(databaseUrl: string, authentication: AuthenticationFixture): Promise<void> {
  const baselinePaths = authentication.storedObjectPaths();
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [session] = await owner<{ id: string; publicId: string; quarantinePath: string; retentionDeadline: string }[]>`
      SELECT session.id, session.public_id AS "publicId", session.quarantine_object_path AS "quarantinePath",
        consent.retention_deadline::text AS "retentionDeadline"
      FROM public.private_media_upload_sessions AS session
      INNER JOIN public.private_media_consents AS consent ON consent.session_id = session.id
      WHERE session.status = 'processed' AND consent.retention_deadline > pg_catalog.clock_timestamp()
      ORDER BY session.finalized_at, session.id LIMIT 1
    `;
    if (!session) throw new Error("Crash-recovery fixture requires a retained processed media session.");
    const shard = createHash("sha256").update(session.publicId).digest("hex").slice(0, 2);
    const orphanMaster = `private/${shard}/${session.publicId}/master-${"4".repeat(64)}.webp`;
    const orphanThumbnail = `private/${shard}/${session.publicId}/thumbnail-${"6".repeat(64)}.webp`;
    const orphanRedaction = `private/${shard}/${session.publicId}/redacted-${"5".repeat(64)}.webp`;
    for (const [bucket, objectPath, body] of [
      ["wp09-render-quarantine", session.quarantinePath, Buffer.from("raw-quarantine-crash")],
      ["wp09-render-private", orphanMaster, Buffer.from("uncommitted-master-crash")],
      ["wp09-render-private", orphanThumbnail, Buffer.from("uncommitted-thumbnail-crash")],
      ["wp09-render-private", orphanRedaction, Buffer.from("failed-redaction-compensation")],
    ] as const) {
      const response = await fetch(`${authentication.origin}/storage/v1/object/${bucket}/${objectPath}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body,
      });
      if (!response.ok) throw new Error(`Crash-recovery fixture could not write ${objectPath}.`);
    }
    await owner`
      UPDATE public.private_media_upload_sessions
      SET terminal_error_code = 'MEDIA_QUARANTINE_DELETE_PENDING'
      WHERE id = ${session.id} AND status = 'processed'
    `;
    await owner`
      INSERT INTO public.private_media_pending_objects (session_id, kind, object_path, delete_after)
      VALUES
        (${session.id}, 'sanitized_master', ${orphanMaster}, pg_catalog.clock_timestamp() - interval '1 second'),
        (${session.id}, 'thumbnail', ${orphanThumbnail}, pg_catalog.clock_timestamp() - interval '1 second'),
        (${session.id}, 'redacted', ${orphanRedaction}, pg_catalog.clock_timestamp() - interval '1 second')
    `;
    const pendingLease = randomUUID();
    const pending = await owner<{ id: string; path: string }[]>`
      SELECT pending_object_id AS id, object_path AS path
      FROM public.claim_private_media_pending_object_cleanup(10, ${pendingLease})
    `;
    if (pending.map((row) => row.path).sort().join(",") !== [orphanMaster, orphanThumbnail, orphanRedaction].sort().join(",")) {
      throw new Error(`Crash-recovery manifest did not expose every uncommitted object: ${JSON.stringify(pending)}.`);
    }
    await removeFixtureStorageObjects(authentication.origin, "wp09-render-private", pending.map((row) => row.path));
    await owner`SELECT public.complete_private_media_pending_object_cleanup(${pendingLease}, ${pending.map((row) => row.id)}::uuid[])`;

    const quarantineLease = randomUUID();
    const quarantine = await owner<{ id: string; path: string }[]>`
      SELECT session_id AS id, quarantine_object_path AS path
      FROM public.claim_private_media_quarantine_cleanup(10, ${quarantineLease})
      WHERE session_id = ${session.id}
    `;
    if (quarantine.length !== 1 || quarantine[0]?.path !== session.quarantinePath) {
      throw new Error(`Committed processing did not durably expose raw-quarantine cleanup: ${JSON.stringify(quarantine)}.`);
    }
    await removeFixtureStorageObjects(authentication.origin, "wp09-render-quarantine", quarantine.map((row) => row.path));
    await owner`SELECT public.complete_private_media_quarantine_cleanup(${quarantineLease}, ${quarantine.map((row) => row.id)}::uuid[])`;
    const [residue] = await owner<{ manifests: number; pendingQuarantine: number; retainedConsent: boolean }[]>`
      SELECT
        (SELECT count(*)::int FROM public.private_media_pending_objects WHERE session_id = ${session.id}) AS manifests,
        (SELECT count(*)::int FROM public.private_media_upload_sessions
          WHERE id = ${session.id} AND terminal_error_code = 'MEDIA_QUARANTINE_DELETE_PENDING') AS "pendingQuarantine",
        (SELECT retention_deadline > pg_catalog.clock_timestamp() FROM public.private_media_consents
          WHERE session_id = ${session.id}) AS "retainedConsent"
    `;
    if (residue?.manifests !== 0 || residue.pendingQuarantine !== 0 || !residue.retainedConsent
      || JSON.stringify(authentication.storedObjectPaths()) !== JSON.stringify(baselinePaths)) {
      throw new Error(`Bounded crash recovery left raw/private object residue or waited for retention: ${JSON.stringify({ residue, paths: authentication.storedObjectPaths() })}.`);
    }
  } finally { await owner.end(); }
}

async function assertHttpMediaPayloadIsolation(databaseUrl: string, receiptIds: readonly string[]): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const rows = await owner<{ receiptId: string; payload: Record<string, unknown> }[]>`
      SELECT receipt_id AS "receiptId", payload FROM public.submission_idempotency_bindings
      WHERE receipt_id = ANY(${receiptIds}::uuid[])
    `;
    if (rows.length !== receiptIds.length) throw new Error("Real HTTP media payload isolation fixtures were not all persisted.");
    const mediaOnlyKeys = ["mediaFile", "mediaPurpose", "mediaOwnsOrPermission", "mediaPrivateStorage", "mediaDerivativeProcessing", "mediaPublicDisplay"];
    for (const row of rows) {
      const leaked = mediaOnlyKeys.filter((key) => Object.hasOwn(row.payload, key));
      if (leaked.length) throw new Error(`Strict WP-08 payload ${row.receiptId} contains media-only fields: ${leaked.join(", ")}.`);
    }
  } finally { await owner.end(); }
}

async function assertAal2MediaReviewHttp(databaseUrl: string, authentication: AuthenticationFixture, receiptId: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [fixture] = await owner<{ assetId: string; intakeId: string; submissionId: string }[]>`
      SELECT asset.id AS "assetId", intake.id AS "intakeId", intake.submission_id AS "submissionId"
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.private_media_upload_sessions AS session ON session.intake_id = intake.id
      INNER JOIN public.private_media_assets AS asset ON asset.session_id = session.id
      WHERE intake.receipt_id = ${receiptId}
      LIMIT 1
    `;
    if (!fixture) throw new Error("AAL2 media-review fixture was not finalized.");
    const token = await authentication.issueToken(ids.reviewerAuth, "render-reviewer@example.invalid", "aal2");
    const headers = { Authorization: `Bearer ${token}`, "X-Request-Id": "req_wp09_media_discovery" };
    const discovery = await fetch(`${origin}/api/admin/submissions/${fixture.submissionId}/media?intakeId=${fixture.intakeId}`, { headers });
    const body = await discovery.json() as { media?: Array<{ assetId: string; width: number; height: number }> };
    if (discovery.status !== 200 || body.media?.length !== 1 || body.media[0]?.assetId !== fixture.assetId) {
      throw new Error(`AAL2 intake media discovery failed exact binding: ${discovery.status} ${JSON.stringify(body)}.`);
    }
    assertPrivateResponseHeaders(discovery.headers, "AAL2 intake media discovery");
    const content = await fetch(`${origin}/api/admin/media/${fixture.assetId}/content?kind=thumbnail`, { headers: { ...headers, "X-Request-Id": "req_wp09_media_view" } });
    if (content.status !== 200 || (await content.arrayBuffer()).byteLength < 1) throw new Error("AAL2 media content route did not return the private thumbnail.");
    assertPrivateResponseHeaders(content.headers, "AAL2 media content");
    const redaction = await fetch(`${origin}/api/admin/media/${fixture.assetId}/redact`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Request-Id": "req_wp09_media_redact" },
      body: JSON.stringify({ reason: "Remove private label corner before review", rectangles: [{ x: 0, y: 0, width: 2, height: 2 }] }),
    });
    const redactionBody = await redaction.json() as Record<string, unknown>;
    if (redaction.status !== 200 || redactionBody.status !== "approved_private" || typeof redactionBody.rectanglesHash !== "string") {
      throw new Error(`AAL2 rectangle redaction failed: ${redaction.status} ${JSON.stringify(redactionBody)}.`);
    }
    const [audit] = await owner<{ discoveries: number; redactions: number; views: number }[]>`
      SELECT
        count(*) FILTER (WHERE action = 'private_media.discover' AND request_id = 'req_wp09_media_discovery')::int AS discoveries,
        count(*) FILTER (WHERE action = 'private_media.view' AND request_id = 'req_wp09_media_view')::int AS views,
        count(*) FILTER (WHERE action = 'private_media.redact' AND request_id = 'req_wp09_media_redact')::int AS redactions
      FROM public.audit_log WHERE actor_id = ${ids.reviewer}
    `;
    if (audit?.discoveries !== 1 || audit.views !== 1 || audit.redactions !== 1) {
      throw new Error(`AAL2 media discovery/view/redaction audit is incomplete: ${JSON.stringify(audit)}.`);
    }
    const pathsBeforeExpiryProbes = authentication.storedObjectPaths();
    await owner`UPDATE public.private_media_assets SET retention_deadline = pg_catalog.clock_timestamp() - interval '1 second' WHERE id = ${fixture.assetId}`;
    const expiredContent = await fetch(`${origin}/api/admin/media/${fixture.assetId}/content?kind=thumbnail`, {
      headers: { ...headers, "X-Request-Id": "req_wp09_expired_media_view" },
    });
    const expiredContentBody = await expiredContent.json() as { error?: { code?: string } };
    if (expiredContent.status !== 404 || expiredContentBody.error?.code !== "PRIVATE_MEDIA_NOT_FOUND") {
      throw new Error(`A previously discovered expired asset remained directly viewable: ${expiredContent.status} ${JSON.stringify(expiredContentBody)}.`);
    }
    const expiredRedaction = await fetch(`${origin}/api/admin/media/${fixture.assetId}/redact`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Request-Id": "req_wp09_expired_media_redact" },
      body: JSON.stringify({ reason: "Expired asset must not accept another redaction", rectangles: [{ x: 2, y: 2, width: 2, height: 2 }] }),
    });
    const expiredRedactionBody = await expiredRedaction.json() as { error?: { code?: string } };
    if (expiredRedaction.status !== 404 || expiredRedactionBody.error?.code !== "PRIVATE_MEDIA_NOT_FOUND") {
      throw new Error(`A previously discovered expired asset remained redactable: ${expiredRedaction.status} ${JSON.stringify(expiredRedactionBody)}.`);
    }
    if (JSON.stringify(authentication.storedObjectPaths()) !== JSON.stringify(pathsBeforeExpiryProbes)) {
      throw new Error("Expired-asset redaction probe wrote a private derivative before transactional eligibility was confirmed.");
    }
  } finally { await owner.end(); }
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

async function runCorrectiveIdempotencyHttpAssertions(turnstileNonce: string): Promise<void> {
  const missingRequest = (modelNumber: string, idempotencyKey: string) => ({
    brand: "WP08 idempotency fixture",
    brokenPart: "Private latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey,
    modelNumber,
    notes: "WP08_IDEMPOTENCY_PRIVATE_SENTINEL",
    privacyConsent: true,
    website: "",
  });

  const changedEmailKey = randomUUID();
  const changedEmailRequest = {
    ...missingRequest("WP08-IDEM-CONTACT-CHANGE", changedEmailKey),
    email: "wp08-contact-original@example.invalid",
    emailFollowUpConsent: true,
  };
  const changedEmailReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...changedEmailRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.50",
    202,
  ), "changed-email conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...changedEmailRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "wp08-contact-changed@example.invalid",
    },
    "203.0.113.50",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "changed-email conflict", [changedEmailReceipt]);

  const addContactKey = randomUUID();
  const addContactRequest = missingRequest("WP08-IDEM-CONTACT-ADD", addContactKey);
  const addContactReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...addContactRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.51",
    202,
  ), "add-contact conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...addContactRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "wp08-contact-added@example.invalid",
      emailFollowUpConsent: true,
    },
    "203.0.113.51",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "add-contact conflict", [addContactReceipt]);

  const removeContactKey = randomUUID();
  const removeContactRequest = {
    ...missingRequest("WP08-IDEM-CONTACT-REMOVE", removeContactKey),
    email: "wp08-contact-removed@example.invalid",
    emailFollowUpConsent: true,
  };
  const removeContactReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...removeContactRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.52",
    202,
  ), "remove-contact conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...removeContactRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "",
      emailFollowUpConsent: false,
    },
    "203.0.113.52",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "remove-contact conflict", [removeContactReceipt]);

  const consentFalseFirstKey = randomUUID();
  const consentFalseFirstRequest = missingRequest("WP08-IDEM-CONSENT-FALSE-TRUE", consentFalseFirstKey);
  const consentFalseFirstReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...consentFalseFirstRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.53",
    202,
  ), "false-to-true consent conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...consentFalseFirstRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      emailFollowUpConsent: true,
    },
    "203.0.113.53",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "false-to-true consent conflict", [consentFalseFirstReceipt]);

  const consentTrueFirstKey = randomUUID();
  const consentTrueFirstRequest = {
    ...missingRequest("WP08-IDEM-CONSENT-TRUE-FALSE", consentTrueFirstKey),
    emailFollowUpConsent: true,
  };
  const consentTrueFirstReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...consentTrueFirstRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.54",
    202,
  ), "true-to-false consent conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...consentTrueFirstRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      emailFollowUpConsent: false,
    },
    "203.0.113.54",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "true-to-false consent conflict", [consentTrueFirstReceipt]);

  const emailConsentKey = randomUUID();
  const emailConsentRequest = {
    ...missingRequest("WP08-IDEM-EMAIL-CONSENT-TRUE-FALSE", emailConsentKey),
    email: "wp08-contact-consent@example.invalid",
    emailFollowUpConsent: true,
  };
  const emailConsentReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...emailConsentRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.61",
    202,
  ), "same-email consent conflict original intake");
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...emailConsentRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      emailFollowUpConsent: false,
    },
    "203.0.113.61",
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "same-email true-to-false consent conflict", [emailConsentReceipt]);

  const normalizedContactKey = randomUUID();
  const normalizedContactRequest = {
    ...missingRequest("WP08-IDEM-CONTACT-NORMALIZED", normalizedContactKey),
    email: "wp08-contact-normalized@example.invalid",
    emailFollowUpConsent: true,
  };
  const normalizedContactReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...normalizedContactRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.58",
    202,
  ), "normalized-contact original intake");
  const normalizedContactRetry = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...normalizedContactRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "  WP08-CONTACT-NORMALIZED@EXAMPLE.INVALID  ",
    },
    "203.0.113.58",
    202,
  ), "normalized-contact exact retry");
  if (normalizedContactRetry !== normalizedContactReceipt) {
    throw new Error("A case/whitespace-equivalent contact retry did not return its original opaque receipt.");
  }

  const emptyContactKey = randomUUID();
  const emptyContactRequest = missingRequest("WP08-IDEM-CONTACT-EMPTY", emptyContactKey);
  const omittedContactReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...emptyContactRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.59",
    202,
  ), "omitted-contact original intake");
  const emptyContactRetry = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...emptyContactRequest,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "",
    },
    "203.0.113.59",
    202,
  ), "empty-contact exact retry");
  if (emptyContactRetry !== omittedContactReceipt) {
    throw new Error("An omitted/empty contact retry did not return its original opaque receipt.");
  }

  const invalidConsentRequest = {
    ...missingRequest("WP08-IDEM-INVALID-CONSENT", randomUUID()),
    email: "wp08-contact-invalid@example.invalid",
    emailFollowUpConsent: false,
  };
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    { ...invalidConsentRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.60",
    400,
  ), "CONSENT_REQUIRED", "brand-new invalid contact consent");

  const semanticBindingIp = "203.0.113.62";
  const semanticBindingK1 = {
    ...missingRequest("WP08-IDEM-SEMANTIC-BINDING", randomUUID()),
    notes: "WP08_IDEMPOTENCY_PRIVATE_SENTINEL semantic K1",
  };
  const semanticBindingReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...semanticBindingK1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    semanticBindingIp,
    202,
  ), "semantic binding K1 intake");
  const semanticBindingK2 = {
    ...semanticBindingK1,
    idempotencyKey: randomUUID(),
    notes: "WP08_IDEMPOTENCY_PRIVATE_SENTINEL semantic K2",
  };
  const semanticDuplicateReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...semanticBindingK2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    semanticBindingIp,
    202,
  ), "semantic binding K2 duplicate intake");
  if (semanticDuplicateReceipt !== semanticBindingReceipt) {
    throw new Error("A second UUID for the same semantic contributor/content did not return the existing opaque receipt.");
  }
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...semanticBindingK2,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "wp08-binding-contact@example.invalid",
      emailFollowUpConsent: true,
    },
    semanticBindingIp,
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "semantic binding changed-contact conflict", [semanticBindingReceipt]);
  assertPrivateError(await postSubmission(
    "/api/v1/submissions/requests",
    {
      ...semanticBindingK2,
      challengeToken: integrationToken(turnstileNonce, "missing_part"),
      email: "wp08-binding-contact@example.invalid",
      emailFollowUpConsent: false,
    },
    semanticBindingIp,
    409,
  ), "IDEMPOTENCY_KEY_REUSED", "semantic binding invalid-consent conflict", [semanticBindingReceipt]);
  const semanticBindingExactRetry = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...semanticBindingK2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    semanticBindingIp,
    202,
  ), "semantic binding K2 exact retry");
  if (semanticBindingExactRetry !== semanticBindingReceipt) {
    throw new Error("An exact K2 semantic-binding retry did not return the originally bound opaque receipt.");
  }

  const endpointIsolationKey = randomUUID();
  const endpointIsolationIp = "203.0.113.55";
  const endpointReceipts = await Promise.all([
    assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...missingRequest("WP08-IDEM-ENDPOINT-ISOLATION", endpointIsolationKey),
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
      },
      endpointIsolationIp,
      202,
    ), "same-UUID missing-part endpoint isolation"),
    assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/designs",
      {
        brand: "WP08 idempotency fixture",
        challengeToken: integrationToken(turnstileNonce, "design_submission"),
        claimedLicense: "NOT-STATED",
        componentName: "Private latch",
        contributionConsent: true,
        creatorName: "WP08 Fixture Creator",
        emailFollowUpConsent: false,
        idempotencyKey: endpointIsolationKey,
        modelNumber: "WP08-IDEM-ENDPOINT-ISOLATION",
        notes: "WP08_IDEMPOTENCY_PRIVATE_SENTINEL",
        privacyConsent: true,
        sourceUrl: "https://example.invalid/wp08-idem-endpoint-isolation",
        website: "",
      },
      endpointIsolationIp,
      202,
    ), "same-UUID design endpoint isolation"),
    assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/fit-confirmations",
      {
        challengeToken: integrationToken(turnstileNonce, "fit_confirmation"),
        contributionConsent: true,
        designRevision: "r-idempotency",
        emailFollowUpConsent: false,
        idempotencyKey: endpointIsolationKey,
        modelNumber: "WP08-IDEM-ENDPOINT-ISOLATION",
        modificationNotes: "WP08_IDEMPOTENCY_PRIVATE_SENTINEL",
        outcome: "unsure",
        partSlug: "wp08-idem-private-latch",
        privacyConsent: true,
        website: "",
      },
      endpointIsolationIp,
      202,
    ), "same-UUID fit endpoint isolation"),
  ]);
  if (new Set(endpointReceipts).size !== 3) {
    throw new Error("One client UUID reused across endpoint kinds did not create three independent opaque receipts.");
  }

  const differentIpKey = randomUUID();
  const differentIpRequest = missingRequest("WP08-IDEM-DIFFERENT-IP", differentIpKey);
  const firstIpReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...differentIpRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.56",
    202,
  ), "same-UUID first-network intake");
  const secondIpReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...differentIpRequest, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.57",
    202,
  ), "same-UUID independent-network intake");
  if (secondIpReceipt === firstIpReceipt) {
    throw new Error("Different network actors reusing one client UUID received the same opaque receipt.");
  }
}

async function runCanonicalUuidHttpAssertions(databaseUrl: string, turnstileNonce: string): Promise<void> {
  const endpoints = [
    {
      action: "missing_part" as const,
      path: "/api/v1/submissions/requests",
      payload: (modelNumber: string) => ({
        brand: "WP08 UUID fixture",
        brokenPart: "Private UUID latch",
        modelNumber,
        notes: "WP08_UUID_PRIVATE_NOTES_SENTINEL",
      }),
      changedPayload: { brokenPart: "Changed private UUID latch" },
    },
    {
      action: "design_submission" as const,
      path: "/api/v1/submissions/designs",
      payload: (modelNumber: string) => ({
        brand: "WP08 UUID fixture",
        claimedLicense: "NOT-STATED",
        componentName: "Private UUID latch",
        creatorName: "WP08 UUID fixture creator",
        modelNumber,
        notes: "WP08_UUID_PRIVATE_NOTES_SENTINEL",
        sourceUrl: `https://example.invalid/${modelNumber.toLowerCase()}`,
      }),
      changedPayload: { claimedLicense: "CC-BY-4.0" },
    },
    {
      action: "fit_confirmation" as const,
      path: "/api/v1/submissions/fit-confirmations",
      payload: (modelNumber: string) => ({
        designRevision: "r-uuid-1",
        modelNumber,
        modificationNotes: "WP08_UUID_PRIVATE_NOTES_SENTINEL",
        outcome: "unsure",
        partSlug: "wp08-private-uuid-latch",
      }),
      changedPayload: { outcome: "does_not_fit" },
    },
  ] as const;
  let ipSuffix = 100;
  const uuidReceipts: string[] = [];

  for (const [endpointIndex, endpoint] of endpoints.entries()) {
    const send = async (
      payload: Record<string, unknown>,
      clientIp: string,
      expectedStatus: number,
    ) => postSubmission(
      endpoint.path,
      { ...payload, challengeToken: integrationToken(turnstileNonce, endpoint.action) },
      clientIp,
      expectedStatus,
    );
    const controls = {
      contributionConsent: true,
      emailFollowUpConsent: false,
      privacyConsent: true,
      website: "",
    };

    const lowerFirst = randomUUID();
    const lowerFirstPayload = {
      ...endpoint.payload(`WP08-UUID-${endpointIndex}-LOWER-UPPER`),
      ...controls,
      idempotencyKey: lowerFirst,
    };
    const lowerReceipt = await assertAcceptedJson(
      await send(lowerFirstPayload, `203.0.113.${ipSuffix}`, 202),
      `${endpoint.action} lowercase UUID intake`,
    );
    const upperReceipt = await assertAcceptedJson(
      await send({ ...lowerFirstPayload, idempotencyKey: lowerFirst.toUpperCase() }, `203.0.113.${ipSuffix}`, 202),
      `${endpoint.action} uppercase UUID retry`,
    );
    if (lowerReceipt !== upperReceipt) throw new Error(`${endpoint.action} UUID case retry changed its receipt.`);
    uuidReceipts.push(lowerReceipt);
    ipSuffix += 1;

    const upperFirst = randomUUID();
    const upperFirstPayload = {
      ...endpoint.payload(`WP08-UUID-${endpointIndex}-UPPER-LOWER`),
      ...controls,
      idempotencyKey: upperFirst.toUpperCase(),
    };
    const upperFirstReceipt = await assertAcceptedJson(
      await send(upperFirstPayload, `203.0.113.${ipSuffix}`, 202),
      `${endpoint.action} uppercase-first UUID intake`,
    );
    const lowerRetryReceipt = await assertAcceptedJson(
      await send({ ...upperFirstPayload, idempotencyKey: upperFirst }, `203.0.113.${ipSuffix}`, 202),
      `${endpoint.action} lowercase UUID retry`,
    );
    if (upperFirstReceipt !== lowerRetryReceipt) throw new Error(`${endpoint.action} reverse UUID case retry changed its receipt.`);
    uuidReceipts.push(upperFirstReceipt);
    ipSuffix += 1;

    for (const [change, changedValues] of [
      ["payload", endpoint.changedPayload],
      ["contact", { email: "wp08-uuid-private@example.invalid", emailFollowUpConsent: true }],
      ["email-consent", { emailFollowUpConsent: true }],
      ["privacy-consent", { privacyConsent: false }],
      ["contribution-consent", { contributionConsent: false }],
    ] as const) {
      const key = randomUUID();
      const original = {
        ...endpoint.payload(`WP08-UUID-${endpointIndex}-${change.toUpperCase()}`),
        ...controls,
        idempotencyKey: key,
      };
      const originalReceipt = await assertAcceptedJson(
        await send(original, `203.0.113.${ipSuffix}`, 202),
        `${endpoint.action} UUID ${change} original`,
      );
      uuidReceipts.push(originalReceipt);
      const conflict = await send(
        { ...original, ...changedValues, idempotencyKey: key.toUpperCase() },
        `203.0.113.${ipSuffix}`,
        409,
      );
      assertPrivateError(conflict, "IDEMPOTENCY_KEY_REUSED", `${endpoint.action} UUID ${change} conflict`, [originalReceipt]);
      ipSuffix += 1;
    }
  }
  privateReceiptSentinels.push(...uuidReceipts);

  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [evidence] = await owner<{ contacts: number; followUps: number; intakes: number; receipts: number; submissions: number }[]>`
      SELECT
        count(DISTINCT parent.id)::int AS submissions,
        count(DISTINCT parent.receipt_id)::int AS receipts,
        count(DISTINCT intake.id)::int AS intakes,
        count(DISTINCT contact.intake_id)::int AS contacts,
        count(DISTINCT follow_up.id)::int AS "followUps"
      FROM public.submissions AS parent
      INNER JOIN public.submission_idempotency_bindings AS intake ON intake.submission_id = parent.id
      LEFT JOIN public.submission_intake_contacts AS contact ON contact.intake_id = intake.id
      LEFT JOIN public.submission_email_follow_ups AS follow_up ON follow_up.intake_id = intake.id
      WHERE parent.payload->>'modelNumber' LIKE 'WP08-UUID-%'
    `;
    if (
      !evidence
      || evidence.submissions !== 21
      || evidence.receipts !== 21
      || evidence.intakes !== 21
      || evidence.contacts !== 0
      || evidence.followUps !== 0
    ) {
      throw new Error("Canonical UUID HTTP matrix persisted duplicate or private side-effect rows.");
    }
  } finally {
    await owner.end();
  }
}

async function runConcurrentHttpOverlapAssertions(databaseUrl: string, turnstileNonce: string): Promise<void> {
  const basePayload = (modelNumber: string, idempotencyKey: string) => ({
    brand: "WP08 concurrency fixture",
    brokenPart: "Private concurrent latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey,
    modelNumber,
    notes: `WP08_CONCURRENT_PRIVATE_SENTINEL_${modelNumber}`,
    privacyConsent: true,
    website: "",
  });

  const identicalModel = "WP08-CONCURRENT-IDENTICAL";
  const identicalKey = randomUUID();
  const identicalPayload = basePayload(identicalModel, identicalKey);
  const identical = await runGatedSubmissionRequests(databaseUrl, turnstileNonce, identicalModel, [
    { clientIp: "203.0.113.94", payload: identicalPayload },
    { clientIp: "203.0.113.94", payload: { ...identicalPayload, idempotencyKey: identicalKey.toUpperCase() } },
  ]);
  const identicalReceipts = await Promise.all(identical.responses.map((response, index) => {
    if (response.status !== 202) throw new Error(`Concurrent identical request ${index + 1} returned ${response.status}.`);
    return assertAcceptedJson(response, `concurrent identical request ${index + 1}`);
  }));
  if (new Set(identicalReceipts).size !== 1) throw new Error("Concurrent canonical UUID requests returned different receipts.");
  privateReceiptSentinels.push(identicalReceipts[0]!);
  const observedBackendPids = [...identical.backendPids];
  await assertConcurrentScenarioState(databaseUrl, identicalModel, {
    contacts: 0,
    falseConsents: 1,
    intakes: 1,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });

  const conflictCases = [
    {
      label: "payload",
      modelNumber: "WP08-CONCURRENT-PAYLOAD",
      mutate: (payload: Record<string, unknown>) => ({ ...payload, brokenPart: "Changed private concurrent latch" }),
    },
    {
      label: "contact",
      modelNumber: "WP08-CONCURRENT-CONTACT",
      mutate: (payload: Record<string, unknown>) => ({
        ...payload,
        email: "wp08-concurrent-contact@example.invalid",
        emailFollowUpConsent: true,
      }),
    },
    {
      label: "consent",
      modelNumber: "WP08-CONCURRENT-CONSENT",
      mutate: (payload: Record<string, unknown>) => ({ ...payload, emailFollowUpConsent: true }),
    },
  ] as const;

  let conflictIpSuffix = 105;
  for (const scenario of conflictCases) {
    const idempotencyKey = randomUUID();
    const original = basePayload(scenario.modelNumber, idempotencyKey);
    const changed = scenario.mutate(original);
    const race = await runGatedSubmissionRequests(databaseUrl, turnstileNonce, scenario.modelNumber, [
      { clientIp: `203.0.113.${conflictIpSuffix}`, payload: original },
      { clientIp: `203.0.113.${conflictIpSuffix}`, payload: changed },
    ]);
    const acceptedIndex = await assertConcurrentWinnerAndConflict(race.responses, `concurrent changed-${scenario.label}`);
    observedBackendPids.push(...race.backendPids);
    const acceptedChangedRequest = acceptedIndex === 1;
    await assertConcurrentScenarioState(databaseUrl, scenario.modelNumber, {
      contacts: scenario.label === "contact" && acceptedChangedRequest ? 1 : 0,
      falseConsents: scenario.label === "contact" || scenario.label === "consent"
        ? (acceptedChangedRequest ? 0 : 1)
        : 1,
      intakes: 1,
      receipts: 1,
      submissions: 1,
      trueConsents: scenario.label === "contact" || scenario.label === "consent"
        ? (acceptedChangedRequest ? 1 : 0)
        : 0,
    });
    conflictIpSuffix += 1;
  }

  const aliasModel = "WP08-CONCURRENT-ALIAS-CONSENT";
  const aliasBase = basePayload(aliasModel, randomUUID());
  const aliasConsent = await runGatedSubmissionRequests(databaseUrl, turnstileNonce, aliasModel, [
    { clientIp: "203.0.113.108", payload: aliasBase },
    {
      clientIp: "203.0.113.108",
      payload: { ...aliasBase, emailFollowUpConsent: true, idempotencyKey: randomUUID() },
    },
  ]);
  const aliasReceipts = await Promise.all(aliasConsent.responses.map((response, index) => {
    if (response.status !== 202) throw new Error(`Concurrent semantic alias ${index + 1} returned ${response.status}.`);
    return assertAcceptedJson(response, `concurrent semantic alias ${index + 1}`);
  }));
  if (new Set(aliasReceipts).size !== 1) throw new Error("Concurrent K1/K2 aliases did not retain one semantic receipt.");
  privateReceiptSentinels.push(aliasReceipts[0]!);
  observedBackendPids.push(...aliasConsent.backendPids);
  await assertConcurrentScenarioState(databaseUrl, aliasModel, {
    contacts: 0,
    falseConsents: 1,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 1,
  });

  await runAliasVersusExactRace(databaseUrl, turnstileNonce, basePayload);
  await assertGlobalSubmissionGraphClean(databaseUrl);
  console.log(`Concurrent HTTP overlap matrix passed across PostgreSQL backend PIDs ${[
    ...new Set(observedBackendPids),
  ].join(", ")}.`);
}

type GatedSubmissionRequest = Readonly<{
  clientIp: string;
  payload: Readonly<Record<string, unknown>>;
}>;

async function runGatedSubmissionRequests(
  databaseUrl: string,
  turnstileNonce: string,
  modelNumber: string,
  requests: readonly GatedSubmissionRequest[],
): Promise<Readonly<{ backendPids: readonly number[]; responses: readonly HttpResponse[] }>> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const gateHigh = randomBytes(4).readInt32BE();
  const gateLow = randomBytes(4).readInt32BE();
  const safeModelNumber = modelNumber.replace(/'/g, "''");
  let lockHeld = false;
  let pending: Promise<readonly HttpResponse[]> | undefined;
  try {
    await owner`SELECT pg_advisory_lock(${gateHigh}, ${gateLow})`;
    lockHeld = true;
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.wp08_test_intake_commit_gate()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $gate$
      BEGIN
        IF NEW.payload->>'modelNumber' = '${safeModelNumber}' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(${gateHigh}, ${gateLow});
        END IF;
        RETURN NEW;
      END
      $gate$
    `);
    await owner.unsafe(`REVOKE ALL ON FUNCTION public.wp08_test_intake_commit_gate() FROM PUBLIC`);
    await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.wp08_test_intake_commit_gate() TO repairprint_submission_service`);
    await owner.unsafe(`
      CREATE CONSTRAINT TRIGGER wp08_test_intake_commit_gate_trg
        AFTER INSERT ON public.submission_idempotency_bindings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.wp08_test_intake_commit_gate()
    `);

    let settled = false;
    pending = Promise.all(requests.map((requestFixture) => postSubmissionUnchecked(
      "/api/v1/submissions/requests",
      {
        ...requestFixture.payload,
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
      },
      requestFixture.clientIp,
    ))).finally(() => { settled = true; });
    const backendPids = await waitForSubmissionBackendOverlap(owner, "wp08-render-primary", 2);
    if (settled) throw new Error(`${modelNumber} responses settled before the commit gate opened.`);
    const [unlocked] = await owner<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${gateHigh}, ${gateLow}) AS unlocked
    `;
    lockHeld = false;
    if (!unlocked?.unlocked) throw new Error(`${modelNumber} advisory gate was not released.`);
    const responses = await pending;
    return Object.freeze({ backendPids, responses: Object.freeze([...responses]) });
  } finally {
    if (lockHeld) await owner`SELECT pg_advisory_unlock(${gateHigh}, ${gateLow})`;
    if (pending) await pending.catch(() => undefined);
    await owner.unsafe(`DROP TRIGGER IF EXISTS wp08_test_intake_commit_gate_trg ON public.submission_idempotency_bindings`);
    await owner.unsafe(`DROP FUNCTION IF EXISTS public.wp08_test_intake_commit_gate()`);
    await owner.end();
  }
}

async function assertConcurrentWinnerAndConflict(
  responses: readonly HttpResponse[],
  label: string,
): Promise<number> {
  const acceptedIndex = responses.findIndex(({ status }) => status === 202);
  const conflictIndex = responses.findIndex(({ status }) => status === 409);
  if (responses.length !== 2 || acceptedIndex < 0 || conflictIndex < 0 || acceptedIndex === conflictIndex) {
    throw new Error(`${label} did not produce exactly one accepted request and one conflict.`);
  }
  const receipt = await assertAcceptedJson(responses[acceptedIndex]!, `${label} winner`);
  privateReceiptSentinels.push(receipt);
  assertPrivateError(responses[conflictIndex]!, "IDEMPOTENCY_KEY_REUSED", `${label} loser`, [receipt]);
  return acceptedIndex;
}

type ConcurrentScenarioExpectation = Readonly<{
  contacts: number;
  falseConsents: number;
  intakes: number;
  receipts: number;
  submissions: number;
  trueConsents: number;
}>;

async function assertConcurrentScenarioState(
  databaseUrl: string,
  modelNumber: string,
  expected: ConcurrentScenarioExpectation,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [actual] = await owner<(ConcurrentScenarioExpectation & Readonly<{
      followUps: number;
      unboundSubmissions: number;
    }>)[]>`
      SELECT
        (SELECT count(*)::int FROM public.submissions AS parent
          WHERE parent.intake_version = 1 AND parent.payload->>'modelNumber' = ${modelNumber}) AS submissions,
        (SELECT count(*)::int FROM public.submission_idempotency_bindings AS intake
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = ${modelNumber}) AS intakes,
        (SELECT count(DISTINCT parent.receipt_id)::int FROM public.submissions AS parent
          WHERE parent.intake_version = 1 AND parent.payload->>'modelNumber' = ${modelNumber}) AS receipts,
        (SELECT count(*)::int FROM public.submission_intake_contacts AS contact
          INNER JOIN public.submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = ${modelNumber}) AS contacts,
        (SELECT count(*)::int FROM public.submission_email_follow_ups AS follow_up
          INNER JOIN public.submission_idempotency_bindings AS intake ON intake.id = follow_up.intake_id
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = ${modelNumber}) AS "followUps",
        (SELECT count(*) FILTER (WHERE intake.email_follow_up_consent = false)::int
          FROM public.submission_idempotency_bindings AS intake
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = ${modelNumber}) AS "falseConsents",
        (SELECT count(*) FILTER (WHERE intake.email_follow_up_consent = true)::int
          FROM public.submission_idempotency_bindings AS intake
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = ${modelNumber}) AS "trueConsents",
        (SELECT count(*)::int FROM public.submissions AS parent
          LEFT JOIN public.submission_idempotency_bindings AS intake ON intake.submission_id = parent.id
          WHERE parent.intake_version = 1
            AND parent.payload->>'modelNumber' = ${modelNumber}
            AND intake.id IS NULL) AS "unboundSubmissions"
    `;
    if (!actual
      || actual.submissions !== expected.submissions
      || actual.intakes !== expected.intakes
      || actual.receipts !== expected.receipts
      || actual.contacts !== expected.contacts
      || actual.followUps !== 0
      || actual.falseConsents !== expected.falseConsents
      || actual.trueConsents !== expected.trueConsents
      || actual.unboundSubmissions !== 0) {
      throw new Error(`${modelNumber} concurrent database state was inconsistent.`);
    }
  } finally {
    await owner.end();
  }
}

async function runAliasVersusExactRace(
  databaseUrl: string,
  turnstileNonce: string,
  basePayload: (modelNumber: string, idempotencyKey: string) => Record<string, unknown>,
): Promise<void> {
  const modelNumber = "WP08-CONCURRENT-ALIAS-EXACT";
  const k1 = basePayload(modelNumber, randomUUID());
  const firstReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.109",
    202,
  ), "alias-vs-exact K1");
  privateReceiptSentinels.push(firstReceipt);

  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const gateHigh = randomBytes(4).readInt32BE();
  const gateLow = randomBytes(4).readInt32BE();
  let lockHeld = false;
  let aliasPending: Promise<HttpResponse> | undefined;
  try {
    await owner`SELECT pg_advisory_lock(${gateHigh}, ${gateLow})`;
    lockHeld = true;
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.wp08_test_intake_commit_gate()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $gate$
      BEGIN
        IF NEW.payload->>'modelNumber' = 'WP08-CONCURRENT-ALIAS-EXACT' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(${gateHigh}, ${gateLow});
        END IF;
        RETURN NEW;
      END
      $gate$
    `);
    await owner.unsafe(`REVOKE ALL ON FUNCTION public.wp08_test_intake_commit_gate() FROM PUBLIC`);
    await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.wp08_test_intake_commit_gate() TO repairprint_submission_service`);
    await owner.unsafe(`
      CREATE CONSTRAINT TRIGGER wp08_test_intake_commit_gate_trg
        AFTER INSERT ON public.submission_idempotency_bindings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.wp08_test_intake_commit_gate()
    `);
    const k2 = { ...k1, idempotencyKey: randomUUID() };
    let aliasSettled = false;
    aliasPending = postSubmissionUnchecked(
      "/api/v1/submissions/requests",
      { ...k2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
      "203.0.113.109",
    ).finally(() => { aliasSettled = true; });
    await waitForSubmissionBackendOverlap(owner, "wp08-render-primary", 1);
    if (aliasSettled) throw new Error("Alias request settled before the alias-vs-exact gate opened.");

    const exactReceipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
      "203.0.113.109",
      202,
    ), "alias-vs-exact concurrent K1 retry");
    if (exactReceipt !== firstReceipt || aliasSettled) {
      throw new Error("Exact retry did not resolve independently while alias creation was gated.");
    }
    const [unlocked] = await owner<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${gateHigh}, ${gateLow}) AS unlocked
    `;
    lockHeld = false;
    if (!unlocked?.unlocked) throw new Error("Alias-vs-exact advisory gate was not released.");
    const aliasReceipt = await assertAcceptedJson(await aliasPending, "alias-vs-exact K2 alias");
    if (aliasReceipt !== firstReceipt) throw new Error("Alias-vs-exact K2 lost the semantic receipt.");
  } finally {
    if (lockHeld) await owner`SELECT pg_advisory_unlock(${gateHigh}, ${gateLow})`;
    if (aliasPending) await aliasPending.catch(() => undefined);
    await owner.unsafe(`DROP TRIGGER IF EXISTS wp08_test_intake_commit_gate_trg ON public.submission_idempotency_bindings`);
    await owner.unsafe(`DROP FUNCTION IF EXISTS public.wp08_test_intake_commit_gate()`);
    await owner.end();
  }
  await assertConcurrentScenarioState(databaseUrl, modelNumber, {
    contacts: 0,
    falseConsents: 2,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });
}

async function assertGlobalSubmissionGraphClean(databaseUrl: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [result] = await owner<{
      duplicateScopes: number;
      orphanContacts: number;
      orphanIntakes: number;
      receiptMismatches: number;
      unboundSubmissions: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM (
          SELECT kind, idempotency_actor_key, idempotency_key_hash
          FROM public.submission_idempotency_bindings
          GROUP BY kind, idempotency_actor_key, idempotency_key_hash
          HAVING count(*) > 1
        ) AS duplicate_scope) AS "duplicateScopes",
        (SELECT count(*)::int FROM public.submission_idempotency_bindings AS intake
          LEFT JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.id IS NULL) AS "orphanIntakes",
        (SELECT count(*)::int FROM public.submission_intake_contacts AS contact
          LEFT JOIN public.submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          WHERE intake.id IS NULL) AS "orphanContacts",
        (SELECT count(*)::int FROM public.submission_idempotency_bindings AS intake
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE intake.kind <> parent.kind
            OR intake.receipt_id <> parent.receipt_id
            OR intake.intake_version <> parent.intake_version
            OR intake.hmac_version <> parent.hmac_version) AS "receiptMismatches",
        (SELECT count(*)::int FROM public.submissions AS parent
          LEFT JOIN public.submission_idempotency_bindings AS intake ON intake.submission_id = parent.id
          WHERE parent.intake_version = 1 AND intake.id IS NULL) AS "unboundSubmissions"
    `;
    if (!result || Object.values(result).some((count) => count !== 0)) {
      throw new Error("Submission graph contains a duplicate, orphan, unbound parent, or receipt mismatch.");
    }
  } finally {
    await owner.end();
  }
}

async function waitForSubmissionBackendOverlap(
  owner: ReturnType<typeof postgres>,
  applicationName: string,
  minimumBackends: number,
): Promise<readonly number[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await owner<{ pid: number }[]>`
      SELECT DISTINCT pid
      FROM pg_catalog.pg_stat_activity
      WHERE usename = ${submissionServiceRole}
        AND application_name = ${applicationName}
        AND state <> 'idle'
        AND pid <> pg_backend_pid()
      ORDER BY pid
    `;
    if (rows.length >= minimumBackends) return Object.freeze(rows.map(({ pid }) => pid));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${minimumBackends} overlapping submission-service PostgreSQL backends.`);
}

async function runHttpFailureInjectionAssertion(databaseUrl: string, turnstileNonce: string): Promise<void> {
  const k1 = {
    brand: "WP08 failure fixture",
    brokenPart: "Private rollback latch",
    contributionConsent: true,
    email: "wp08-failure-private@example.invalid",
    emailFollowUpConsent: true,
    idempotencyKey: randomUUID(),
    modelNumber: "WP08-FAILURE-ROLLBACK-100",
    notes: "WP08_FAILURE_INJECTION_PRIVATE_K1_SENTINEL",
    privacyConsent: true,
    website: "",
  };
  const k1Receipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.95",
    202,
  ), "failure-injection K1 intake");
  privateReceiptSentinels.push(k1Receipt);
  const k2 = {
    ...k1,
    idempotencyKey: randomUUID(),
    notes: "WP08_FAILURE_INJECTION_PRIVATE_K2_SENTINEL",
  };
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const baseline = await privateStateSnapshot(databaseUrl);
  try {
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.wp08_test_reject_intake_commit()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $failure$
      BEGIN
        IF NEW.payload->>'notes' = 'WP08_FAILURE_INJECTION_PRIVATE_K2_SENTINEL' THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'WP08_TEST_INJECTED_DATABASE_FAILURE_SENTINEL';
        END IF;
        RETURN NEW;
      END
      $failure$
    `);
    await owner.unsafe(`REVOKE ALL ON FUNCTION public.wp08_test_reject_intake_commit() FROM PUBLIC`);
    await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.wp08_test_reject_intake_commit() TO repairprint_submission_service`);
    await owner.unsafe(`
      CREATE CONSTRAINT TRIGGER wp08_test_reject_intake_commit_trg
        AFTER INSERT ON public.submission_idempotency_bindings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.wp08_test_reject_intake_commit()
    `);
    const failure = await postSubmission(
      "/api/v1/submissions/requests",
      {
        challengeToken: integrationToken(turnstileNonce, "missing_part"),
        ...k2,
      },
      "203.0.113.95",
      503,
    );
    assertPrivateError(
      failure,
      "SUBMISSION_UNAVAILABLE",
      "deferred database failure injection",
      ["wp08-failure-private@example.invalid", "WP08_TEST_INJECTED_DATABASE_FAILURE_SENTINEL"],
    );
  } finally {
    await owner.unsafe(`DROP TRIGGER IF EXISTS wp08_test_reject_intake_commit_trg ON public.submission_idempotency_bindings`);
    await owner.unsafe(`DROP FUNCTION IF EXISTS public.wp08_test_reject_intake_commit()`);
    await owner.end();
  }
  assertPrivateStateUnchanged(baseline, await privateStateSnapshot(databaseUrl), false, "deferred database failure injection");
  await assertConcurrentScenarioState(databaseUrl, k1.modelNumber, {
    contacts: 1,
    falseConsents: 0,
    intakes: 1,
    receipts: 1,
    submissions: 1,
    trueConsents: 1,
  });
  const postFailureOwner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [failureState] = await postFailureOwner<{
      k1ReceiptMatches: boolean;
      k2Contacts: number;
      k2Intakes: number;
      orphanIntakes: number;
    }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM public.submissions AS parent
          WHERE parent.payload->>'modelNumber' = 'WP08-FAILURE-ROLLBACK-100'
            AND parent.receipt_id = ${k1Receipt}::uuid
        ) AS "k1ReceiptMatches",
        (SELECT count(*)::int FROM public.submission_idempotency_bindings AS intake
          INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.payload->>'modelNumber' = 'WP08-FAILURE-ROLLBACK-100'
            AND intake.payload->>'notes' = 'WP08_FAILURE_INJECTION_PRIVATE_K2_SENTINEL') AS "k2Intakes",
        (SELECT count(*)::int FROM public.submission_intake_contacts AS contact
          INNER JOIN public.submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          WHERE intake.payload->>'notes' = 'WP08_FAILURE_INJECTION_PRIVATE_K2_SENTINEL') AS "k2Contacts",
        (SELECT count(*)::int FROM public.submission_idempotency_bindings AS intake
          LEFT JOIN public.submissions AS parent ON parent.id = intake.submission_id
          WHERE parent.id IS NULL) AS "orphanIntakes"
    `;
    if (!failureState
      || !failureState.k1ReceiptMatches
      || failureState.k2Intakes !== 0
      || failureState.k2Contacts !== 0
      || failureState.orphanIntakes !== 0) {
      throw new Error("Failed K2 alias changed K1 or left a private intake/contact/orphan.");
    }
  } finally {
    await postFailureOwner.end();
  }

  const recoveredReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    "203.0.113.95",
    202,
  ), "failure-injection K2 retry after rollback");
  if (recoveredReceipt !== k1Receipt) throw new Error("K2 retry after injected rollback lost K1's receipt.");
  await assertConcurrentScenarioState(databaseUrl, k1.modelNumber, {
    contacts: 2,
    falseConsents: 0,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 2,
  });
  await assertGlobalSubmissionGraphClean(databaseUrl);
}

async function runCleanupAliasRaceAssertion(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  turnstileNonce: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const gateHigh = randomBytes(4).readInt32BE();
  const gateLow = randomBytes(4).readInt32BE();
  const clientIp = "203.0.113.96";
  const k1 = {
    brand: "WP08 cleanup race fixture",
    brokenPart: "Private cleanup latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey: randomUUID(),
    modelNumber: "WP08-CLEANUP-RACE-100",
    notes: "WP08_CLEANUP_RACE_PRIVATE_K1_SENTINEL",
    privacyConsent: true,
    website: "",
  };
  const k1Receipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    clientIp,
    202,
  ), "cleanup-race K1");
  privateReceiptSentinels.push(k1Receipt);
  const k2 = {
    ...k1,
    idempotencyKey: randomUUID(),
    notes: "WP08_CLEANUP_RACE_PRIVATE_K2_SENTINEL",
  };
  let lockHeld = false;
  try {
    const [k1Intake] = await owner<{ id: string }[]>`
      SELECT intake.id
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
      WHERE parent.payload->>'modelNumber' = 'WP08-CLEANUP-RACE-100'
        AND intake.payload->>'notes' = 'WP08_CLEANUP_RACE_PRIVATE_K1_SENTINEL'
    `;
    if (!k1Intake) throw new Error("Cleanup-race K1 intake was not persisted.");
    await setOwnerFixtureExpiry(owner, k1Intake.id, "future");

    await owner`SELECT pg_advisory_lock(${gateHigh}, ${gateLow})`;
    lockHeld = true;
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.wp08_test_cleanup_alias_gate()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $gate$
      BEGIN
        IF NEW.payload->>'notes' = 'WP08_CLEANUP_RACE_PRIVATE_K2_SENTINEL' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(${gateHigh}, ${gateLow});
        END IF;
        RETURN NEW;
      END
      $gate$
    `);
    await owner.unsafe(`REVOKE ALL ON FUNCTION public.wp08_test_cleanup_alias_gate() FROM PUBLIC`);
    await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.wp08_test_cleanup_alias_gate() TO repairprint_submission_service`);
    await owner.unsafe(`
      CREATE CONSTRAINT TRIGGER wp08_test_cleanup_alias_gate_trg
        AFTER INSERT ON public.submission_idempotency_bindings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.wp08_test_cleanup_alias_gate()
    `);

    let k2Settled = false;
    const k2Request = postSubmission(
      "/api/v1/submissions/requests",
      { ...k2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
      clientIp,
      202,
    ).finally(() => { k2Settled = true; });
    await waitForSubmissionBackendOverlap(owner, "wp08-render-primary", 1);
    if (k2Settled) throw new Error("Cleanup-race alias returned before its commit gate.");
    await waitForDatabaseDeadline(owner, k1Intake.id);

    const cleanupDuringAlias = await callSubmissionCleanup(submissionDatabaseUrl, "wp08-cleanup-race-active");
    if (cleanupDuringAlias.deletedIntakes !== 0 || cleanupDuringAlias.deletedSubmissions !== 0) {
      throw new Error("Cleanup deleted a parent or intake locked by alias creation.");
    }
    const [unlocked] = await owner<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${gateHigh}, ${gateLow}) AS unlocked
    `;
    lockHeld = false;
    if (!unlocked?.unlocked) throw new Error("Cleanup-race advisory gate was not released.");
    const k2Receipt = await assertAcceptedJson(await k2Request, "cleanup-race K2 alias");
    if (k2Receipt !== k1Receipt) throw new Error("Cleanup-race K2 lost the semantic receipt.");

    const [deadlineRelation] = await owner<{ k2BeforeE1: boolean; k2OutlivesK1: boolean }[]>`
      SELECT
        newer.accepted_at < older.retention_expires_at AS "k2BeforeE1",
        newer.retention_expires_at > older.retention_expires_at AS "k2OutlivesK1"
      FROM public.submission_idempotency_bindings AS older
      INNER JOIN public.submission_idempotency_bindings AS newer
        ON newer.submission_id = older.submission_id AND newer.id <> older.id
      WHERE older.id = ${k1Intake.id}
        AND newer.payload->>'notes' = 'WP08_CLEANUP_RACE_PRIVATE_K2_SENTINEL'
    `;
    if (!deadlineRelation?.k2BeforeE1 || !deadlineRelation.k2OutlivesK1) {
      throw new Error("Cleanup-race K2 was not accepted before E1 with its own later E2.");
    }

    const cleanupAfterAlias = await callSubmissionCleanup(submissionDatabaseUrl, "wp08-cleanup-race-after-alias");
    if (cleanupAfterAlias.deletedIntakes !== 1 || cleanupAfterAlias.deletedSubmissions !== 0) {
      throw new Error("Post-alias cleanup did not remove only expired K1.");
    }
    const [survivor] = await owner<{ intakes: number; notes: string; submissions: number }[]>`
      SELECT
        count(DISTINCT parent.id)::int AS submissions,
        count(DISTINCT intake.id)::int AS intakes,
        max(intake.payload->>'notes') AS notes
      FROM public.submissions AS parent
      INNER JOIN public.submission_idempotency_bindings AS intake ON intake.submission_id = parent.id
      WHERE parent.payload->>'modelNumber' = 'WP08-CLEANUP-RACE-100'
    `;
    if (!survivor || survivor.submissions !== 1 || survivor.intakes !== 1
      || survivor.notes !== "WP08_CLEANUP_RACE_PRIVATE_K2_SENTINEL") {
      throw new Error("K2 did not preserve its parent and private immutable snapshot after E1 cleanup.");
    }

    const [k2Intake] = await owner<{ id: string }[]>`
      SELECT intake.id
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
      WHERE parent.payload->>'modelNumber' = 'WP08-CLEANUP-RACE-100'
    `;
    if (!k2Intake) throw new Error("Cleanup-race K2 intake disappeared unexpectedly.");
    await setOwnerFixtureExpiry(owner, k2Intake.id, "expired");
    const finalCleanup = await callSubmissionCleanup(submissionDatabaseUrl, "wp08-cleanup-race-final");
    if (finalCleanup.deletedIntakes !== 1 || finalCleanup.deletedSubmissions !== 1) {
      throw new Error("Final-intake cleanup did not remove the semantic parent and receipt.");
    }
  } finally {
    if (lockHeld) await owner`SELECT pg_advisory_unlock(${gateHigh}, ${gateLow})`;
    await owner.unsafe(`DROP TRIGGER IF EXISTS wp08_test_cleanup_alias_gate_trg ON public.submission_idempotency_bindings`);
    await owner.unsafe(`DROP FUNCTION IF EXISTS public.wp08_test_cleanup_alias_gate()`);
    await owner.end();
  }
}

async function setOwnerFixtureExpiry(
  owner: ReturnType<typeof postgres>,
  intakeId: string,
  mode: "future" | "expired",
): Promise<void> {
  await owner.unsafe(`ALTER TABLE public.submission_idempotency_bindings DISABLE TRIGGER submission_intakes_immutable_row_trg`);
  try {
    if (mode === "future") {
      await owner`
        UPDATE public.submission_idempotency_bindings
        SET retention_expires_at = pg_catalog.clock_timestamp() + interval '5 seconds'
        WHERE id = ${intakeId}
      `;
    } else {
      await owner`
        UPDATE public.submission_idempotency_bindings
        SET accepted_at = pg_catalog.clock_timestamp() - interval '2 days',
            challenge_verified_at = pg_catalog.clock_timestamp() - interval '2 days',
            retention_expires_at = pg_catalog.clock_timestamp() - interval '1 day'
        WHERE id = ${intakeId}
      `;
    }
  } finally {
    await owner.unsafe(`ALTER TABLE public.submission_idempotency_bindings ENABLE TRIGGER submission_intakes_immutable_row_trg`);
  }
}

async function waitForDatabaseDeadline(owner: ReturnType<typeof postgres>, intakeId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await owner<{ expired: boolean }[]>`
      SELECT retention_expires_at <= pg_catalog.clock_timestamp() AS expired
      FROM public.submission_idempotency_bindings
      WHERE id = ${intakeId}
    `;
    if (row?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the cleanup-race intake deadline.");
}

async function callSubmissionCleanup(
  submissionDatabaseUrl: string,
  applicationName: string,
): Promise<Readonly<{ deletedContacts: number; deletedFollowUps: number; deletedIntakes: number; deletedSubmissions: number }>> {
  const url = new URL(submissionDatabaseUrl);
  url.searchParams.set("application_name", applicationName);
  const service = postgres(url.toString(), { prepare: false, max: 1 });
  try {
    const [result] = await service<{
      deletedContacts: number;
      deletedFollowUps: number;
      deletedIntakes: number;
      deletedSubmissions: number;
    }[]>`
      SELECT
        deleted_contacts::int AS "deletedContacts",
        deleted_follow_ups::int AS "deletedFollowUps",
        deleted_intakes::int AS "deletedIntakes",
        deleted_submissions::int AS "deletedSubmissions"
      FROM public.cleanup_expired_submission_intakes(10)
    `;
    if (!result) throw new Error("Submission cleanup returned no result.");
    return Object.freeze(result);
  } finally {
    await service.end();
  }
}

async function assertNoEphemeralSubmissionTestHooks(databaseUrl: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [result] = await owner<{ functions: number; triggers: number }[]>`
      SELECT
        (SELECT count(*)::int
          FROM pg_catalog.pg_proc AS procedure
          INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public' AND procedure.proname LIKE 'wp08_test_%') AS functions,
        (SELECT count(*)::int
          FROM pg_catalog.pg_trigger
          WHERE NOT tgisinternal AND tgname LIKE 'wp08_test_%') AS triggers
    `;
    if (!result || result.functions !== 0 || result.triggers !== 0) {
      throw new Error("Ephemeral WP-08 synchronization objects remained in the test database.");
    }
  } finally {
    await owner.end();
  }
}

async function createRestartFixture(turnstileNonce: string): Promise<RestartFixture> {
  const clientIp = "203.0.113.93";
  const k1 = Object.freeze({
    brand: "WP08 restart fixture",
    brokenPart: "Private restart latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey: randomUUID(),
    modelNumber: "WP08-RESTART-100",
    notes: "WP08_RESTART_PRIVATE_K1_SENTINEL",
    privacyConsent: true,
    website: "",
  });
  const firstReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    clientIp,
    202,
  ), "process-A restart K1");
  const k2 = Object.freeze({
    ...k1,
    idempotencyKey: randomUUID(),
    notes: "WP08_RESTART_PRIVATE_K2_SENTINEL",
  });
  const aliasReceipt = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k2, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    clientIp,
    202,
  ), "process-A restart K2 alias");
  if (aliasReceipt !== firstReceipt) throw new Error("Process A did not bind K1 and K2 to one receipt.");
  privateReceiptSentinels.push(firstReceipt);
  return Object.freeze({ clientIp, k1, k2, receiptId: firstReceipt });
}

async function createPolicyRestartFixture(turnstileNonce: string): Promise<PolicyRestartFixture> {
  const clientIp = "203.0.113.116";
  const k1 = Object.freeze({
    brand: "WP08 policy restart fixture",
    brokenPart: "Private policy restart latch",
    contributionConsent: true,
    emailFollowUpConsent: false,
    idempotencyKey: randomUUID(),
    modelNumber: "WP08-POLICY-RESTART-100",
    notes: "WP08_RESTART_PRIVATE_POLICY_K1_SENTINEL",
    privacyConsent: true,
    website: "",
  });
  const receiptId = await assertAcceptedJson(await postSubmission(
    "/api/v1/submissions/requests",
    { ...k1, challengeToken: integrationToken(turnstileNonce, "missing_part") },
    clientIp,
    202,
  ), "process-A policy V1 K1");
  privateReceiptSentinels.push(receiptId);
  return Object.freeze({ clientIp, k1, receiptId });
}

async function assertKeyChangeAndApplicationRestart(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
  hmacKeyA: string,
  hmacKeyB: string,
  fixture: RestartFixture,
  policyFixture: PolicyRestartFixture,
  processAPid: number,
): Promise<void> {
  await assertConcurrentScenarioState(databaseUrl, "WP08-RESTART-100", {
    contacts: 0,
    falseConsents: 2,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });
  const baseline = await privateStateSnapshot(databaseUrl);
  const processB = await startBuiltNextServer(
    productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKeyB),
    port,
    "wp08-restart-key-b",
  );
  if (processB.pid === processAPid) throw new Error("Key-B process reused Process A's PID.");
  try {
    for (const [label, payload] of [
      ["key-B exact K1", fixture.k1],
      ["key-B new UUID", { ...fixture.k1, idempotencyKey: randomUUID() }],
    ] as const) {
      const failure = await postSubmission(
        "/api/v1/submissions/requests",
        { ...payload, challengeToken: integrationToken(processB.turnstileNonce, "missing_part") },
        fixture.clientIp,
        503,
      );
      assertPrivateError(failure, "SUBMISSION_UNAVAILABLE", label, [fixture.receiptId]);
    }
  } finally {
    await stopBuiltNextServer(processB);
    assertPrivateDataAbsent(processB.output(), "key-B Next.js process output");
    assertReceiptDataAbsent(processB.output(), "key-B Next.js process output");
  }
  assertPrivateStateUnchanged(baseline, await privateStateSnapshot(databaseUrl), true, "key-B fail-closed restart");
  await assertConcurrentScenarioState(databaseUrl, "WP08-RESTART-100", {
    contacts: 0,
    falseConsents: 2,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });

  const policyV2Environment = productionEnvironment(
    databaseUrl,
    submissionDatabaseUrl,
    authenticationOrigin,
    hmacKeyA,
  );
  policyV2Environment.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-render-retention-v2";
  const policyV2Process = await startBuiltNextServer(
    policyV2Environment,
    port,
    "wp08-restart-policy-v2",
  );
  if (policyV2Process.pid === processAPid || policyV2Process.pid === processB.pid) {
    throw new Error("Policy-V2 process did not receive a fresh PID.");
  }
  const policyK2 = Object.freeze({
    ...policyFixture.k1,
    idempotencyKey: randomUUID(),
    notes: "WP08_RESTART_PRIVATE_POLICY_K2_SENTINEL",
  });
  try {
    const changedPolicyK1 = await postSubmission(
      "/api/v1/submissions/requests",
      {
        ...policyFixture.k1,
        challengeToken: integrationToken(policyV2Process.turnstileNonce, "missing_part"),
      },
      policyFixture.clientIp,
      409,
    );
    assertPrivateError(changedPolicyK1, "IDEMPOTENCY_KEY_REUSED", "policy V1 K1 retried under V2", [policyFixture.receiptId]);
    const policyK2Receipt = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      { ...policyK2, challengeToken: integrationToken(policyV2Process.turnstileNonce, "missing_part") },
      policyFixture.clientIp,
      202,
    ), "policy V2 K2 alias");
    if (policyK2Receipt !== policyFixture.receiptId) throw new Error("Policy V2 K2 lost the V1 semantic receipt.");
    const policyK2Retry = await assertAcceptedJson(await postSubmission(
      "/api/v1/submissions/requests",
      { ...policyK2, challengeToken: integrationToken(policyV2Process.turnstileNonce, "missing_part") },
      policyFixture.clientIp,
      202,
    ), "policy V2 K2 exact retry");
    if (policyK2Retry !== policyFixture.receiptId) throw new Error("Policy V2 K2 exact retry lost its receipt.");
    await registerSubmissionGraphSentinels(databaseUrl, "WP08-POLICY-RESTART-100");
  } finally {
    await stopBuiltNextServer(policyV2Process);
    assertPrivateDataAbsent(policyV2Process.output(), "policy-V2 Next.js process output");
    assertReceiptDataAbsent(policyV2Process.output(), "policy-V2 Next.js process output");
  }
  await assertPolicyRestartState(databaseUrl);
  const postPolicyBaseline = await privateStateSnapshot(databaseUrl);

  const processA2 = await startBuiltNextServer(
    productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKeyA),
    port,
    "wp08-restart-key-a-restored",
  );
  if (processA2.pid === processAPid || processA2.pid === processB.pid || processA2.pid === policyV2Process.pid) {
    throw new Error("Restored-key process did not receive a fresh PID.");
  }
  try {
    for (const [label, payload, expectedReceipt, clientIp] of [
      ["restored-key exact K1", fixture.k1, fixture.receiptId, fixture.clientIp],
      ["restored-key exact K2", fixture.k2, fixture.receiptId, fixture.clientIp],
      ["restored-policy exact V1 K1", policyFixture.k1, policyFixture.receiptId, policyFixture.clientIp],
    ] as const) {
      const receipt = await assertAcceptedJson(await postSubmission(
        "/api/v1/submissions/requests",
        { ...payload, challengeToken: integrationToken(processA2.turnstileNonce, "missing_part") },
        clientIp,
        202,
      ), label);
      if (receipt !== expectedReceipt) throw new Error(`${label} lost the original receipt.`);
    }
    const policyK2UnderV1 = await postSubmission(
      "/api/v1/submissions/requests",
      { ...policyK2, challengeToken: integrationToken(processA2.turnstileNonce, "missing_part") },
      policyFixture.clientIp,
      409,
    );
    assertPrivateError(policyK2UnderV1, "IDEMPOTENCY_KEY_REUSED", "policy V2 K2 retried under V1", [policyFixture.receiptId]);
    for (const [label, payload] of [
      ["restored-key changed K1", { ...fixture.k1, modelNumber: "WP08-RESTART-CHANGED" }],
      ["restored-key changed K2", { ...fixture.k2, emailFollowUpConsent: true }],
    ] as const) {
      const conflict = await postSubmission(
        "/api/v1/submissions/requests",
        { ...payload, challengeToken: integrationToken(processA2.turnstileNonce, "missing_part") },
        fixture.clientIp,
        409,
      );
      assertPrivateError(conflict, "IDEMPOTENCY_KEY_REUSED", label, [fixture.receiptId]);
    }
    const publicProbe = await request("/methodology", 200);
    assertPrivateDataAbsent(publicProbe.body, "post-restart public methodology");
    assertReceiptDataAbsent(publicProbe.body, "post-restart public methodology");
  } finally {
    await stopBuiltNextServer(processA2);
    assertPrivateDataAbsent(processA2.output(), "restored-key Next.js process output");
    assertReceiptDataAbsent(processA2.output(), "restored-key Next.js process output");
  }
  assertPrivateStateUnchanged(postPolicyBaseline, await privateStateSnapshot(databaseUrl), false, "restored-key restart");
  await assertConcurrentScenarioState(databaseUrl, "WP08-RESTART-100", {
    contacts: 0,
    falseConsents: 2,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });
  await assertGlobalSubmissionGraphClean(databaseUrl);
  await assertSubmissionKeyPinProvisioningRace(
    databaseUrl,
    submissionDatabaseUrl,
    authenticationOrigin,
    hmacKeyA,
    hmacKeyB,
  );
  console.log(`Production restart checks passed with distinct PIDs ${processAPid}, ${processB.pid}, ${policyV2Process.pid}, and ${processA2.pid}.`);
}

async function assertSubmissionKeyPinProvisioningRace(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  authenticationOrigin: string,
  hmacKeyA: string,
  hmacKeyB: string,
): Promise<void> {
  await expireAndCleanupAllSubmissionFixtures(databaseUrl, submissionDatabaseUrl, authenticationOrigin);
  await assertStoredSubmissionKeyPin(databaseUrl, hmacKeyA);

  const raceServer = await startBuiltNextServer(
    productionEnvironment(databaseUrl, submissionDatabaseUrl, authenticationOrigin, hmacKeyA),
    port,
    "wp08-pin-runtime-race",
  );
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  const gateHigh = randomBytes(4).readInt32BE();
  const gateLow = randomBytes(4).readInt32BE();
  let lockHeld = false;
  let intakePending: Promise<HttpResponse> | undefined;
  let provisioner: RunningProvisioningCommand | undefined;
  try {
    await owner`SELECT pg_advisory_lock(${gateHigh}, ${gateLow})`;
    lockHeld = true;
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.wp08_test_pin_runtime_gate()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $gate$
      BEGIN
        IF NEW.payload->>'notes' = 'WP08_PIN_RACE_PRIVATE_SENTINEL' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(${gateHigh}, ${gateLow});
        END IF;
        RETURN NEW;
      END
      $gate$
    `);
    await owner.unsafe(`REVOKE ALL ON FUNCTION public.wp08_test_pin_runtime_gate() FROM PUBLIC`);
    await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.wp08_test_pin_runtime_gate() TO repairprint_submission_service`);
    await owner.unsafe(`
      CREATE CONSTRAINT TRIGGER wp08_test_pin_runtime_gate_trg
        AFTER INSERT ON public.submission_idempotency_bindings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.wp08_test_pin_runtime_gate()
    `);

    let intakeSettled = false;
    intakePending = postSubmissionUnchecked(
      "/api/v1/submissions/requests",
      {
        brand: "WP08 pin race fixture",
        brokenPart: "Private pin race latch",
        challengeToken: integrationToken(raceServer.turnstileNonce, "missing_part"),
        contributionConsent: true,
        emailFollowUpConsent: false,
        idempotencyKey: randomUUID(),
        modelNumber: "WP08-PIN-RACE-100",
        notes: "WP08_PIN_RACE_PRIVATE_SENTINEL",
        privacyConsent: true,
        website: "",
      },
      "203.0.113.117",
    ).finally(() => { intakeSettled = true; });
    await waitForSubmissionBackendOverlap(owner, "wp08-pin-runtime-race", 1);
    if (intakeSettled) throw new Error("Pin-race intake settled before its commit gate opened.");

    const provisionerUrl = new URL(databaseUrl);
    provisionerUrl.searchParams.set("application_name", "wp08-pin-provision-race");
    provisioner = startSubmissionKeyPinProvisioningCommand(provisionerUrl.toString(), hmacKeyB, true);
    await waitForProvisionerPinLock(owner, provisioner);
    if (intakeSettled) throw new Error("Pin-race intake settled before the replacement attempt blocked.");

    const [unlocked] = await owner<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${gateHigh}, ${gateLow}) AS unlocked
    `;
    lockHeld = false;
    if (!unlocked?.unlocked) throw new Error("Pin-race advisory gate was not released.");
    const intakeReceipt = await assertAcceptedJson(await intakePending, "pin replacement race intake winner");
    privateReceiptSentinels.push(intakeReceipt);
    const provisionResult = await provisioner.completion;
    if (provisionResult.status === 0
      || provisionResult.stdout.trim() !== ""
      || provisionResult.stderr.trim() !== JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_FAILED" })) {
      throw new Error("Concurrent key replacement did not fail with retained-data safe output.");
    }
    assertPrivateDataAbsent(provisionResult.stdout, "pin-race provisioning stdout");
    assertPrivateDataAbsent(provisionResult.stderr, "pin-race provisioning stderr");
    await assertStoredSubmissionKeyPin(databaseUrl, hmacKeyA);
    await assertConcurrentScenarioState(databaseUrl, "WP08-PIN-RACE-100", {
      contacts: 0,
      falseConsents: 1,
      intakes: 1,
      receipts: 1,
      submissions: 1,
      trueConsents: 0,
    });
    await assertGlobalSubmissionGraphClean(databaseUrl);
    await registerSubmissionGraphSentinels(databaseUrl, "WP08-PIN-RACE-100");
  } finally {
    if (lockHeld) await owner`SELECT pg_advisory_unlock(${gateHigh}, ${gateLow})`;
    if (intakePending) await intakePending.catch(() => undefined);
    if (provisioner && provisioner.child.exitCode === null && provisioner.child.signalCode === null) {
      provisioner.child.kill("SIGKILL");
      await provisioner.completion.catch(() => undefined);
    }
    await owner.unsafe(`DROP TRIGGER IF EXISTS wp08_test_pin_runtime_gate_trg ON public.submission_idempotency_bindings`);
    await owner.unsafe(`DROP FUNCTION IF EXISTS public.wp08_test_pin_runtime_gate()`);
    await owner.end();
    await stopBuiltNextServer(raceServer);
    assertPrivateDataAbsent(raceServer.output(), "pin-race Next.js process output");
    assertReceiptDataAbsent(raceServer.output(), "pin-race Next.js process output");
  }

  await expireAndCleanupAllSubmissionFixtures(databaseUrl, submissionDatabaseUrl, authenticationOrigin);
  const replacement = runSubmissionKeyPinProvisioningCommand(databaseUrl, hmacKeyB, true);
  if (replacement.status !== 0
    || replacement.stderr.trim() !== ""
    || replacement.stdout.trim() !== JSON.stringify({ code: "SUBMISSION_HMAC_KEY_PIN_READY", outcome: "replaced" })) {
    throw new Error("Empty-state key-pin replacement did not return the safe replaced result.");
  }
  assertPrivateDataAbsent(replacement.stdout, "empty-state key-pin replacement output");
  await assertStoredSubmissionKeyPin(databaseUrl, hmacKeyB);
  const emptyState = await privateStateSnapshot(databaseUrl);
  if (Object.values(emptyState).some((count) => count !== 0)) {
    throw new Error("Key-pin replacement left private intake/rate state behind.");
  }
}

async function assertPolicyRestartState(databaseUrl: string): Promise<void> {
  await assertConcurrentScenarioState(databaseUrl, "WP08-POLICY-RESTART-100", {
    contacts: 0,
    falseConsents: 2,
    intakes: 2,
    receipts: 1,
    submissions: 1,
    trueConsents: 0,
  });
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const [state] = await owner<{
      distinctDeadlines: number;
      distinctNotes: number;
      v1Policies: number;
      v2Policies: number;
    }[]>`
      SELECT
        count(DISTINCT intake.retention_expires_at)::int AS "distinctDeadlines",
        count(DISTINCT intake.payload->>'notes')::int AS "distinctNotes",
        count(*) FILTER (WHERE intake.retention_policy_version = 'wp08-render-retention-v1')::int AS "v1Policies",
        count(*) FILTER (WHERE intake.retention_policy_version = 'wp08-render-retention-v2')::int AS "v2Policies"
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
      WHERE parent.payload->>'modelNumber' = 'WP08-POLICY-RESTART-100'
    `;
    if (!state
      || state.distinctDeadlines !== 2
      || state.distinctNotes !== 2
      || state.v1Policies !== 1
      || state.v2Policies !== 1) {
      throw new Error("Policy restart did not retain two exact immutable policy/deadline snapshots.");
    }
  } finally {
    await owner.end();
  }
}

async function registerSubmissionGraphSentinels(databaseUrl: string, modelNumber: string): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    const rows = await owner<{
      contactDigest: string | null;
      contentFingerprint: string;
      contributorKey: string;
      idempotencyActorKey: string;
      idempotencyKeyHash: string;
      receiptId: string;
      requestFingerprint: string;
    }[]>`
      SELECT
        intake.contact_digest AS "contactDigest",
        parent.content_fingerprint AS "contentFingerprint",
        parent.contributor_key AS "contributorKey",
        intake.idempotency_actor_key AS "idempotencyActorKey",
        intake.idempotency_key_hash AS "idempotencyKeyHash",
        intake.receipt_id AS "receiptId",
        intake.request_fingerprint AS "requestFingerprint"
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
      WHERE parent.intake_version = 1
        AND parent.payload->>'modelNumber' = ${modelNumber}
    `;
    if (rows.length === 0) throw new Error(`${modelNumber} did not expose a private sentinel graph.`);
    privateReceiptSentinels.push(...rows.map(({ receiptId }) => receiptId));
    privateDemandSentinels.push(...rows.flatMap((row) => [row.contentFingerprint, row.contributorKey]));
    databaseSecretSentinels.push(...rows.flatMap((row) => [
      row.contactDigest,
      row.idempotencyActorKey,
      row.idempotencyKeyHash,
      row.requestFingerprint,
    ]).filter((value): value is string => value !== null));
  } finally {
    await owner.end();
  }
}

async function waitForProvisionerPinLock(
  owner: ReturnType<typeof postgres>,
  provisioner: RunningProvisioningCommand,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (provisioner.child.exitCode !== null || provisioner.child.signalCode !== null) {
      throw new Error("Key-pin provisioner exited before blocking behind the live intake pin lock.");
    }
    const [activity] = await owner<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'wp08-pin-provision-race'
          AND state = 'active'
          AND wait_event_type = 'Lock'
      ) AS blocked
    `;
    if (activity?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Key-pin provisioner did not block behind the live intake pin lock.");
}

async function expireAndCleanupAllSubmissionFixtures(
  databaseUrl: string,
  submissionDatabaseUrl: string,
  storageOrigin: string,
): Promise<void> {
  const owner = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    await owner.unsafe(`ALTER TABLE public.private_media_consents DISABLE TRIGGER private_media_consents_immutable`);
    try {
      await owner`
        UPDATE public.private_media_consents
        SET accepted_at = pg_catalog.statement_timestamp() - interval '2 days',
            retention_deadline = pg_catalog.statement_timestamp() - interval '1 day'
      `;
    } finally {
      await owner.unsafe(`ALTER TABLE public.private_media_consents ENABLE TRIGGER private_media_consents_immutable`);
    }
    await owner`
      UPDATE public.private_media_upload_sessions
      SET capability_expires_at = pg_catalog.statement_timestamp() - interval '1 day',
          finalize_capability_expires_at = pg_catalog.statement_timestamp() - interval '1 day',
          processing_lease_expires_at = CASE WHEN processing_lease_expires_at IS NULL THEN NULL ELSE pg_catalog.statement_timestamp() - interval '1 day' END
    `;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const leaseToken = randomUUID();
      const claimed = await owner<{ privatePaths: string[]; quarantinePath: string; sessionId: string }[]>`
        SELECT session_id AS "sessionId", quarantine_object_path AS "quarantinePath", private_object_paths AS "privatePaths"
        FROM public.claim_expired_private_media(100, ${leaseToken})
      `;
      if (claimed.length === 0) break;
      await removeFixtureStorageObjects(storageOrigin, "wp09-render-quarantine", claimed.map((row) => row.quarantinePath));
      await removeFixtureStorageObjects(storageOrigin, "wp09-render-private", claimed.flatMap((row) => row.privatePaths));
      await owner`SELECT * FROM public.complete_private_media_cleanup(${leaseToken}, ${claimed.map((row) => row.sessionId)}::uuid[])`;
    }
    await owner.unsafe(`ALTER TABLE public.submission_idempotency_bindings DISABLE TRIGGER submission_intakes_immutable_row_trg`);
    try {
      await owner`
        UPDATE public.submission_idempotency_bindings
        SET accepted_at = pg_catalog.statement_timestamp() - interval '2 days',
            challenge_verified_at = pg_catalog.statement_timestamp() - interval '2 days',
            contact_retention_expires_at = CASE
              WHEN contact_retention_expires_at IS NULL THEN NULL
              ELSE pg_catalog.statement_timestamp() - interval '1 day'
            END,
            retention_expires_at = pg_catalog.statement_timestamp() - interval '1 day'
      `;
    } finally {
      await owner.unsafe(`ALTER TABLE public.submission_idempotency_bindings ENABLE TRIGGER submission_intakes_immutable_row_trg`);
    }
  } finally {
    await owner.end();
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const cleanup = await callSubmissionCleanup(submissionDatabaseUrl, "wp08-pin-race-cleanup");
    if (cleanup.deletedIntakes === 0 && cleanup.deletedContacts === 0 && cleanup.deletedFollowUps === 0) break;
  }
  await clearSubmissionRateLimits(databaseUrl);
  const state = await privateStateSnapshot(databaseUrl);
  if (state.submissions !== 0
    || state.intakes !== 0
    || state.receipts !== 0
    || state.contacts !== 0
    || state.followUps !== 0
    || state.orphanIntakes !== 0) {
    throw new Error("Private fixtures were not fully removed before the key-pin race.");
  }
}

async function removeFixtureStorageObjects(storageOrigin: string, bucket: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const response = await fetch(`${storageOrigin}/storage/v1/object/${bucket}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }),
  });
  if (!response.ok) throw new Error("Private-media fixture storage cleanup failed.");
}

function assertPrivateError(
  response: HttpResponse,
  expectedCode: string,
  label: string,
  forbiddenValues: readonly string[] = [],
): void {
  let body: { error?: { code?: unknown; message?: unknown; requestId?: unknown } };
  try {
    body = JSON.parse(response.body) as typeof body;
  } catch {
    throw new Error(`${label} did not return a structured private JSON error.`);
  }
  if (body.error?.code !== expectedCode
    || typeof body.error.message !== "string"
    || typeof body.error.requestId !== "string"
    || Object.keys(body).join(",") !== "error"
    || Object.keys(body.error).sort().join(",") !== "code,message,requestId") {
    throw new Error(`${label} returned an unsafe error shape: ${response.body}.`);
  }
  for (const forbidden of forbiddenValues) assertExcludes(response.body, forbidden, label);
  assertPrivateDataAbsent(response.body, label);
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
  evidenceIntakeId: string;
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
      kind: string;
      payload: Record<string, unknown>;
      receiptId: string;
      status: string;
    }[]>`
      SELECT
        id,
        receipt_id AS "receiptId",
        kind,
        status,
        (SELECT intake.payload
          FROM submission_idempotency_bindings AS intake
          WHERE intake.submission_id = submissions.id
          ORDER BY intake.accepted_at, intake.id
          LIMIT 1) AS payload,
        (SELECT max(contact.contact_email)
          FROM submission_idempotency_bindings AS intake
          INNER JOIN submission_intake_contacts AS contact ON contact.intake_id = intake.id
          WHERE intake.submission_id = submissions.id) AS "contactEmail",
        content_fingerprint AS "contentFingerprint",
        contributor_key AS "contributorKey"
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
      || new Set(missing.map((row) => row.contributorKey)).size !== 2) {
      throw new Error("Stable retry or same-key independent-contributor demand grouping failed through production HTTP.");
    }
    const mainBindings = await sql<{
      id: string;
      idempotencyActorKey: string;
      idempotencyKeyHash: string;
      kind: string;
      requestFingerprint: string;
      submissionId: string;
    }[]>`
      SELECT
        id,
        kind,
        idempotency_actor_key AS "idempotencyActorKey",
        idempotency_key_hash AS "idempotencyKeyHash",
        submission_id AS "submissionId",
        request_fingerprint AS "requestFingerprint"
      FROM submission_idempotency_bindings
      WHERE submission_id = ANY(${rows.map((row) => row.id)}::uuid[])
      ORDER BY created_at, submission_id
    `;
    const missingIds = new Set(missing.map((row) => row.id));
    const missingBindings = mainBindings.filter((binding) => missingIds.has(binding.submissionId));
    if (mainBindings.length !== 5
      || new Set(mainBindings.map((binding) => binding.submissionId)).size !== 5
      || missingBindings.length !== 2
      || new Set(missingBindings.map((binding) => binding.idempotencyActorKey)).size !== 2
      || new Set(missingBindings.map((binding) => binding.idempotencyKeyHash)).size !== 1
      || new Set(missingBindings.map((binding) => binding.requestFingerprint)).size !== 2) {
      throw new Error(`Production HTTP rows have unsafe or missing idempotency bindings: ${JSON.stringify(mainBindings)}.`);
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
        (SELECT count(*)::int FROM submission_intake_contacts AS contact
          INNER JOIN submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          WHERE intake.submission_id = ANY(${rows.map((row) => row.id)}::uuid[])) AS "contactRows",
        (SELECT count(*)::int FROM submission_email_follow_ups
          WHERE submission_id = ANY(${rows.map((row) => row.id)}::uuid[])) AS "followUps",
        (SELECT count(*)::int FROM submissions
          WHERE payload->>'brand' = 'WP08_HTTP_HONEYPOT_SENTINEL') AS "honeypotRows",
        (
          (SELECT count(*)::int FROM public_catalogue_fitments
            WHERE to_jsonb(public_catalogue_fitments)::text LIKE '%WP08%')
          + (SELECT count(*)::int FROM public_catalogue_unavailable_sources
            WHERE to_jsonb(public_catalogue_unavailable_sources)::text LIKE '%WP08%')
          + (SELECT count(*)::int FROM public_search_documents
            WHERE to_jsonb(public_search_documents)::text LIKE '%WP08%')
        ) AS "publicLeaks",
        (
          (SELECT count(*)::int FROM fitments WHERE slug LIKE 'wp08-%')
          + (SELECT count(*)::int FROM designs WHERE slug LIKE 'wp08-%')
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

    const idempotencyRows = await sql<{
      contactEmail: string | null;
      contentFingerprint: string;
      contributorKey: string;
      id: string;
      kind: string;
      modelNumber: string;
      payload: Record<string, unknown>;
      receiptId: string;
      status: string;
    }[]>`
      SELECT
        id,
        receipt_id AS "receiptId",
        kind,
        status,
        payload,
        payload->>'modelNumber' AS "modelNumber",
        (SELECT max(contact.contact_email)
          FROM submission_idempotency_bindings AS intake
          INNER JOIN submission_intake_contacts AS contact ON contact.intake_id = intake.id
          WHERE intake.submission_id = submissions.id) AS "contactEmail",
        content_fingerprint AS "contentFingerprint",
        contributor_key AS "contributorKey"
      FROM submissions
      WHERE intake_version = 1 AND payload->>'modelNumber' LIKE 'WP08-IDEM-%'
      ORDER BY created_at, id
    `;
    const expectedIdempotencyCounts = new Map<string, number>([
      ["WP08-IDEM-CONTACT-CHANGE", 1],
      ["WP08-IDEM-CONTACT-ADD", 1],
      ["WP08-IDEM-CONTACT-REMOVE", 1],
      ["WP08-IDEM-CONSENT-FALSE-TRUE", 1],
      ["WP08-IDEM-CONSENT-TRUE-FALSE", 1],
      ["WP08-IDEM-EMAIL-CONSENT-TRUE-FALSE", 1],
      ["WP08-IDEM-CONTACT-NORMALIZED", 1],
      ["WP08-IDEM-CONTACT-EMPTY", 1],
      ["WP08-IDEM-SEMANTIC-BINDING", 1],
      ["WP08-IDEM-ENDPOINT-ISOLATION", 3],
      ["WP08-IDEM-DIFFERENT-IP", 2],
    ]);
    if (idempotencyRows.length !== 14 || idempotencyRows.some((row) => row.status !== "pending")) {
      throw new Error(`Corrective idempotency HTTP fixtures persisted an unexpected queue: ${JSON.stringify(idempotencyRows)}.`);
    }
    const idempotencyBindings = await sql<{
      idempotencyActorKey: string;
      idempotencyKeyHash: string;
      kind: string;
      payload: Record<string, unknown>;
      requestFingerprint: string;
      submissionId: string;
    }[]>`
      SELECT
        kind,
        idempotency_actor_key AS "idempotencyActorKey",
        idempotency_key_hash AS "idempotencyKeyHash",
        submission_id AS "submissionId",
        payload,
        request_fingerprint AS "requestFingerprint"
      FROM submission_idempotency_bindings
      WHERE submission_id = ANY(${idempotencyRows.map((row) => row.id)}::uuid[])
      ORDER BY created_at, submission_id, idempotency_key_hash
    `;
    if (idempotencyBindings.length !== 15
      || idempotencyBindings.some((binding) => !/^[0-9a-f]{64}$/.test(binding.idempotencyActorKey))) {
      throw new Error(`Corrective idempotency rows have unsafe or missing private bindings: ${JSON.stringify(idempotencyBindings)}.`);
    }
    privateReceiptSentinels.push(...new Set([
      ...rows.map((row) => row.receiptId),
      ...idempotencyRows.map((row) => row.receiptId),
    ]));
    privateDemandSentinels.push(...new Set([
      ...rows.flatMap((row) => [row.contributorKey, row.contentFingerprint]),
      ...idempotencyRows.flatMap((row) => [row.contributorKey, row.contentFingerprint]),
    ]));
    databaseSecretSentinels.push(...new Set([
      ...mainBindings.flatMap((binding) => [
        binding.idempotencyActorKey,
        binding.idempotencyKeyHash,
        binding.requestFingerprint,
      ]),
      ...idempotencyBindings.flatMap((binding) => [
        binding.idempotencyActorKey,
        binding.idempotencyKeyHash,
        binding.requestFingerprint,
      ]),
    ]));
    const allPrivateDigests = await sql<{
      contactDigest: string | null;
      contentFingerprint: string;
      contributorKey: string;
      idempotencyActorKey: string;
      idempotencyKeyHash: string;
      receiptId: string;
      requestFingerprint: string;
    }[]>`
      SELECT
        intake.contact_digest AS "contactDigest",
        parent.content_fingerprint AS "contentFingerprint",
        parent.contributor_key AS "contributorKey",
        intake.idempotency_actor_key AS "idempotencyActorKey",
        intake.idempotency_key_hash AS "idempotencyKeyHash",
        intake.receipt_id AS "receiptId",
        intake.request_fingerprint AS "requestFingerprint"
      FROM public.submission_idempotency_bindings AS intake
      INNER JOIN public.submissions AS parent ON parent.id = intake.submission_id
      WHERE parent.intake_version = 1
    `;
    privateReceiptSentinels.push(...allPrivateDigests.map(({ receiptId }) => receiptId));
    privateDemandSentinels.push(...allPrivateDigests.flatMap((row) => [
      row.contentFingerprint,
      row.contributorKey,
    ]));
    databaseSecretSentinels.push(...allPrivateDigests.flatMap((row) => [
      row.contactDigest,
      row.idempotencyActorKey,
      row.idempotencyKeyHash,
      row.requestFingerprint,
    ]).filter((value): value is string => value !== null));
    const [publicRelations] = await sql<{ serialized: string }[]>`
      SELECT COALESCE(string_agg(surface.serialized, ''), '') AS serialized
      FROM (
        SELECT to_jsonb(catalogue)::text AS serialized
        FROM public.public_catalogue_fitments AS catalogue
        UNION ALL
        SELECT to_jsonb(unavailable)::text AS serialized
        FROM public.public_catalogue_unavailable_sources AS unavailable
        UNION ALL
        SELECT to_jsonb(search_document)::text AS serialized
        FROM public.public_search_documents AS search_document
      ) AS surface
    `;
    if (!publicRelations) throw new Error("Public relation privacy scan returned no row.");
    assertPrivateDataAbsent(publicRelations.serialized, "public catalogue/search database relations");
    assertReceiptDataAbsent(publicRelations.serialized, "public catalogue/search database relations");
    const serializedIdempotencyPayloads = JSON.stringify(idempotencyRows.map((row) => row.payload));
    for (const forbidden of [
      '"challengeToken"',
      '"contributionConsent"',
      '"email"',
      '"emailFollowUpConsent"',
      '"idempotencyActorKey"',
      '"idempotencyKey"',
      '"privacyConsent"',
      '"website"',
      "wp08-contact-original@example.invalid",
      "wp08-contact-changed@example.invalid",
      "wp08-contact-added@example.invalid",
      "wp08-contact-removed@example.invalid",
      "wp08-contact-normalized@example.invalid",
      "wp08-contact-invalid@example.invalid",
      "wp08-contact-consent@example.invalid",
      "wp08-binding-contact@example.invalid",
    ]) assertExcludes(serializedIdempotencyPayloads, forbidden, "stored corrective idempotency payloads");
    for (const [modelNumber, expectedCount] of expectedIdempotencyCounts) {
      const actualCount = idempotencyRows.filter((row) => row.modelNumber === modelNumber).length;
      if (actualCount !== expectedCount) {
        throw new Error(`${modelNumber} persisted ${actualCount} rows instead of ${expectedCount}.`);
      }
    }
    if (idempotencyRows.some((row) => row.modelNumber === "WP08-IDEM-INVALID-CONSENT")) {
      throw new Error("A brand-new invalid-consent request persisted unexpectedly.");
    }

    const expectedContacts = new Map<string, string | null>([
      ["WP08-IDEM-CONTACT-CHANGE", "wp08-contact-original@example.invalid"],
      ["WP08-IDEM-CONTACT-ADD", null],
      ["WP08-IDEM-CONTACT-REMOVE", "wp08-contact-removed@example.invalid"],
      ["WP08-IDEM-CONSENT-FALSE-TRUE", null],
      ["WP08-IDEM-CONSENT-TRUE-FALSE", null],
      ["WP08-IDEM-EMAIL-CONSENT-TRUE-FALSE", "wp08-contact-consent@example.invalid"],
      ["WP08-IDEM-CONTACT-NORMALIZED", "wp08-contact-normalized@example.invalid"],
      ["WP08-IDEM-CONTACT-EMPTY", null],
      ["WP08-IDEM-SEMANTIC-BINDING", null],
    ]);
    for (const [modelNumber, expectedContact] of expectedContacts) {
      const [row] = idempotencyRows.filter((candidate) => candidate.modelNumber === modelNumber);
      if (!row || row.contactEmail !== expectedContact) {
        throw new Error(`${modelNumber} stored the wrong first-writer contact state.`);
      }
    }
    if (idempotencyRows.some((row) =>
      row.contactEmail !== (expectedContacts.get(row.modelNumber) ?? null))) {
      throw new Error("A corrective idempotency fixture stored contact outside its first-writer state.");
    }

    const [semanticBindingSubmission] = idempotencyRows.filter((row) =>
      row.modelNumber === "WP08-IDEM-SEMANTIC-BINDING");
    if (!semanticBindingSubmission) throw new Error("The semantic-dedupe parent fixture was not retained.");
    const semanticBindings = idempotencyBindings.filter((binding) =>
      binding.submissionId === semanticBindingSubmission.id);
    if (semanticBindings.length !== 2
      || semanticBindings.some((binding) =>
        binding.kind !== "missing_part" || binding.submissionId !== semanticBindingSubmission.id)
      || new Set(semanticBindings.map((binding) => binding.idempotencyActorKey)).size !== 1
      || new Set(semanticBindings.map((binding) => binding.idempotencyKeyHash)).size !== 2
      || new Set(semanticBindings.map((binding) => binding.requestFingerprint)).size !== 2
      || new Set(semanticBindings.map((binding) => binding.payload.notes)).size !== 2
      || !semanticBindings.some((binding) => binding.payload.notes === "WP08_IDEMPOTENCY_PRIVATE_SENTINEL semantic K1")
      || !semanticBindings.some((binding) => binding.payload.notes === "WP08_IDEMPOTENCY_PRIVATE_SENTINEL semantic K2")) {
      throw new Error("Semantic duplicate UUIDs did not retain two complete immutable intakes for one parent and receipt.");
    }

    const endpointIsolationRows = idempotencyRows.filter((row) => row.modelNumber === "WP08-IDEM-ENDPOINT-ISOLATION");
    const endpointIsolationIds = new Set(endpointIsolationRows.map((row) => row.id));
    const endpointIsolationBindings = idempotencyBindings.filter((binding) =>
      endpointIsolationIds.has(binding.submissionId));
    if (new Set(endpointIsolationRows.map((row) => row.kind)).size !== 3
      || new Set(endpointIsolationRows.map((row) => row.receiptId)).size !== 3) {
      throw new Error("Same-actor UUID reuse did not remain isolated by endpoint kind.");
    }
    if (endpointIsolationBindings.length !== 3
      || new Set(endpointIsolationBindings.map((binding) => binding.kind)).size !== 3
      || new Set(endpointIsolationBindings.map((binding) => binding.idempotencyActorKey)).size !== 1
      || new Set(endpointIsolationBindings.map((binding) => binding.idempotencyKeyHash)).size !== 1) {
      throw new Error("Same-actor UUID reuse did not retain endpoint-isolated private bindings.");
    }
    const differentIpRows = idempotencyRows.filter((row) => row.modelNumber === "WP08-IDEM-DIFFERENT-IP");
    const differentIpIds = new Set(differentIpRows.map((row) => row.id));
    const differentIpBindings = idempotencyBindings.filter((binding) => differentIpIds.has(binding.submissionId));
    if (new Set(differentIpRows.map((row) => row.contributorKey)).size !== 2
      || new Set(differentIpRows.map((row) => row.contentFingerprint)).size !== 1
      || new Set(differentIpRows.map((row) => row.receiptId)).size !== 2
      || differentIpBindings.length !== 2
      || new Set(differentIpBindings.map((binding) => binding.idempotencyActorKey)).size !== 2
      || new Set(differentIpBindings.map((binding) => binding.idempotencyKeyHash)).size !== 1) {
      throw new Error("Different network actors did not receive independent idempotency namespaces.");
    }
    const [idempotencyPrivacy] = await sql<{ followUps: number; publicLeaks: number }[]>`
      SELECT
        (SELECT count(*)::int FROM submission_email_follow_ups
          WHERE submission_id = ANY(${idempotencyRows.map((row) => row.id)}::uuid[])) AS "followUps",
        (
          (SELECT count(*)::int FROM public_catalogue_fitments
            WHERE to_jsonb(public_catalogue_fitments)::text LIKE '%WP08-IDEM-%')
          + (SELECT count(*)::int FROM public_catalogue_unavailable_sources
            WHERE to_jsonb(public_catalogue_unavailable_sources)::text LIKE '%WP08-IDEM-%')
          + (SELECT count(*)::int FROM public_search_documents
            WHERE to_jsonb(public_search_documents)::text LIKE '%WP08-IDEM-%')
        ) AS "publicLeaks"
    `;
    if (!idempotencyPrivacy || idempotencyPrivacy.followUps !== 0 || idempotencyPrivacy.publicLeaks !== 0) {
      throw new Error(`Corrective idempotency fixtures crossed a private boundary: ${JSON.stringify(idempotencyPrivacy)}.`);
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
      WHERE
        (scope = 'anonymous-submission:global:10m' AND request_count IN (6, 15))
        OR (scope = 'anonymous-submission:global:24h' AND request_count IN (6, 16))
        OR (scope = 'anonymous-submission:missing_part:10m' AND request_count = 5)
        OR (scope = 'anonymous-submission:missing_part:24h' AND request_count = 6)
      ORDER BY scope, request_count
    `;
    const actualRateEvidence = highCountRateBuckets
      .map((row) => `${row.scope}|${row.requestCount}`)
      .sort();
    const expectedRateEvidence = [
      "anonymous-submission:global:10m|6",
      "anonymous-submission:global:10m|15",
      "anonymous-submission:global:10m|15",
      "anonymous-submission:global:24h|6",
      "anonymous-submission:global:24h|16",
      "anonymous-submission:global:24h|16",
      "anonymous-submission:missing_part:10m|5",
      "anonymous-submission:missing_part:24h|6",
    ].sort();
    if (JSON.stringify(actualRateEvidence) !== JSON.stringify(expectedRateEvidence)) {
      throw new Error(`Production HTTP rate-bucket evidence was unexpected: ${JSON.stringify(actualRateEvidence)}.`);
    }

    const evidenceSubmission = fitReports.find((row) => typeof row.payload.evidenceUrl === "string");
    if (!evidenceSubmission) throw new Error("Production HTTP evidence submission was not stored privately.");
    const evidenceIntake = mainBindings.find((binding) => binding.submissionId === evidenceSubmission.id);
    if (!evidenceIntake) throw new Error("Production HTTP evidence intake was not stored privately.");
    const nonEvidenceSubmission = missing[0];
    if (!nonEvidenceSubmission) throw new Error("Production HTTP non-evidence fixture was not stored privately.");
    return Object.freeze({
      evidenceIntakeId: evidenceIntake.id,
      evidenceSubmissionId: evidenceSubmission.id,
      nonEvidenceSubmissionId: nonEvidenceSubmission.id,
    });
  } finally {
    await sql.end();
  }
}

async function assertPrivateEvidenceAuthorization(
  submissionIds: Readonly<{ evidenceIntakeId: string; evidenceSubmissionId: string; nonEvidenceSubmissionId: string }>,
  authentication: AuthenticationFixture,
): Promise<void> {
  const submissionId = submissionIds.evidenceSubmissionId;
  const intakeId = submissionIds.evidenceIntakeId;
  const endpoint = `/api/admin/submissions/${submissionId}/evidence?intakeId=${encodeURIComponent(intakeId)}`;
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
    "wp08-contact-original@example.invalid",
    "wp08-contact-changed@example.invalid",
    "wp08-contact-added@example.invalid",
    "wp08-contact-removed@example.invalid",
    "wp08-contact-normalized@example.invalid",
    "wp08-contact-invalid@example.invalid",
    "wp08-contact-consent@example.invalid",
    "wp08-binding-contact@example.invalid",
    "WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL",
    "contact_email",
    "contributor_key",
    "content_fingerprint",
    "idempotency_actor_key",
    "idempotencyActorKey",
    "idempotency_key_hash",
    "request_fingerprint",
    "submission_idempotency_bindings",
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
      || body.intakeId !== intakeId
      || body.evidenceUrl !== "https://example.invalid/private-fit?token=WP08_HTTP_PRIVATE_EVIDENCE_SENTINEL"
      || Object.keys(body).sort().join(",") !== "evidenceUrl,intakeId,submissionId") {
      throw new Error(`${label} private evidence detail returned an unsafe shape: ${response.body}.`);
    }
    for (const forbidden of [
      "wp08-http-one@example.invalid",
      "wp08-http-two@example.invalid",
      "wp08-http-evidence@example.invalid",
      "wp08-contact-original@example.invalid",
      "wp08-contact-changed@example.invalid",
      "wp08-contact-added@example.invalid",
      "wp08-contact-removed@example.invalid",
      "wp08-contact-normalized@example.invalid",
      "wp08-contact-invalid@example.invalid",
      "wp08-contact-consent@example.invalid",
      "wp08-binding-contact@example.invalid",
      "WP08_HTTP_PRIVATE_NOTES_SENTINEL",
      "WP08_MODERATION_ONLY_SENTINEL",
      "contact_email",
      "contributor_key",
      "content_fingerprint",
      "idempotency_actor_key",
      "idempotencyActorKey",
      "submission_idempotency_bindings",
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

async function assertSourceAdministrationHttp(authentication: AuthenticationFixture): Promise<void> {
  const adminAal2 = await authentication.issueToken(ids.adminAuth, "render-admin@example.invalid", "aal2");
  const termsCheckedAt = "2026-07-12T00:00:00.000Z";
  const expiresAt = "2027-07-13T00:00:00.000Z";
  const policy = await privateStaffPost("/api/admin/source-policies", adminAal2, {
    platform: "render-source.example",
    policyVersion: "render-source-manual-v1",
    termsUrl: "https://render-source.example/official-terms",
    termsChecksum: "a".repeat(64),
    termsCheckedAt,
    expiresAt,
    decision: "creator_submission",
    allowedFields: ["landing_page_url", "title", "creator_name"],
    automationAllowed: false,
    commercialUseAllowed: null,
    adapterEnabled: false,
    evidence: { kind: "fictional-built-http-policy" },
    reason: "Record the fictional built-HTTP source policy fixture.",
  }, 201, "req_wp10_http_policy");
  const policyBody = JSON.parse(policy.body) as { policyReview?: { reviewId?: unknown } };
  const reviewId = policyBody.policyReview?.reviewId;
  if (typeof reviewId !== "string") throw new Error(`Built-HTTP policy response lacked its review ID: ${policy.body}.`);

  const forbiddenPolicy = await privateStaffPost("/api/admin/source-policies", adminAal2, {
    platform: "render-source-forbidden.example",
    policyVersion: "render-source-forbidden-v1",
    termsUrl: "https://render-source.example/forbidden-terms",
    termsChecksum: "b".repeat(64),
    termsCheckedAt,
    expiresAt,
    decision: "creator_submission",
    allowedFields: ["title", "files"],
    automationAllowed: false,
    commercialUseAllowed: null,
    adapterEnabled: false,
    evidence: { kind: "must-not-persist" },
    reason: "Reject a field ceiling violation before persistence.",
  }, 400, "req_wp10_http_policy_forbidden");
  assertExcludes(forbiddenPolicy.body, "part.stl", "forbidden source policy response");

  const manual = await privateStaffPost("/api/admin/source-candidates", adminAal2, {
    platform: "render-source.example",
    externalId: "manual-http-1",
    origin: "manual",
    policyReviewId: reviewId,
    payload: { landing_page_url: "https://render-source.example/manual/1", title: "Manual HTTP fixture", creator_name: "Fixture creator" },
    retrievedAt: "2026-07-13T00:00:00.000Z",
  }, 201, "req_wp10_http_manual");
  const manualBody = JSON.parse(manual.body) as { candidate?: { versionId?: unknown } };
  if (typeof manualBody.candidate?.versionId !== "string") {
    throw new Error(`Built-HTTP manual candidate response lacked its version: ${manual.body}.`);
  }
  const creator = await privateStaffPost("/api/admin/source-candidates", adminAal2, {
    platform: "render-source.example",
    externalId: "creator-http-1",
    origin: "creator_submission",
    policyReviewId: reviewId,
    payload: { landing_page_url: "https://render-source.example/creator/1", title: "Creator HTTP fixture", creator_name: "Fixture creator" },
    retrievedAt: "2026-07-13T00:01:00.000Z",
  }, 201, "req_wp10_http_creator");
  assertIncludes(creator.body, "versionId", "built-HTTP creator candidate");
  await privateStaffPost(`/api/admin/source-candidates/${manualBody.candidate.versionId}/transition`, adminAal2, {
    expectedStage: "discovered",
    nextStage: "fetched",
    reason: "Advance the built-HTTP manual source fixture.",
  }, 200, "req_wp10_http_transition");

  const workerResponse = await fetch(`${origin}/api/internal/source-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sourceWorkerSecret}`, Accept: "application/json" },
  });
  const workerBody = await workerResponse.text();
  if (workerResponse.status !== 200) {
    throw new Error(`Genuine-role built-HTTP source worker returned ${workerResponse.status}: ${workerBody.slice(0, 500)}.`);
  }
  const workerResult = JSON.parse(workerBody) as { result?: { claimed?: unknown; completed?: unknown } };
  if (typeof workerResult.result?.claimed !== "number" || workerResult.result.claimed < 1
    || workerResult.result.completed !== workerResult.result.claimed) {
    throw new Error(`Genuine-role built-HTTP source worker did not complete its claimed jobs: ${workerBody}.`);
  }
  assertPrivateResponseHeaders(workerResponse.headers, "built-HTTP source worker");
}

async function privateStaffPost(
  pathname: string,
  token: string,
  payload: Readonly<Record<string, unknown>>,
  expectedStatus: number,
  requestId: string,
): Promise<HttpResponse> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${pathname} returned ${response.status}, expected ${expectedStatus}. Body: ${body.slice(0, 500)}`);
  }
  assertPrivateResponseHeaders(response.headers, pathname);
  return Object.freeze({ body, headers: response.headers, status: response.status });
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

async function startBuiltNextServer(
  baseEnvironment: NodeJS.ProcessEnv,
  listenPort: number,
  applicationName: string,
): Promise<RunningNextServer> {
  const turnstileNonce = randomBytes(24).toString("hex");
  const preload = pathToFileURL(path.join(process.cwd(), "scripts", "turnstile-integration-preload.mjs")).href;
  const turnstilePreload = baseEnvironment.DEMO_MODE === "false" ? `--import=${preload}` : undefined;
  const serviceUrl = new URL(baseEnvironment.SUBMISSION_DATABASE_URL!);
  serviceUrl.searchParams.set("application_name", applicationName);
  const analyticsUrl = new URL(baseEnvironment.ANALYTICS_DATABASE_URL!);
  analyticsUrl.searchParams.set("application_name", `${applicationName}-analytics`);
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(listenPort)],
    {
      cwd: process.cwd(),
      env: {
        ...baseEnvironment,
        CI: "true",
        NODE_OPTIONS: [baseEnvironment.NODE_OPTIONS, turnstilePreload].filter(Boolean).join(" "),
        REPAIRPRINT_HTTP_TEST_NONCE: turnstileNonce,
        REPAIRPRINT_INTEGRATION_TEST: "production-render",
        ANALYTICS_DATABASE_URL: analyticsUrl.toString(),
        SUBMISSION_DATABASE_URL: serviceUrl.toString(),
        VERCEL: "1",
        VERCEL_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (!child.pid) throw new Error("Built Next.js process did not expose a PID.");
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const targetOrigin = `http://127.0.0.1:${listenPort}`;
  await waitForServer(child, targetOrigin, () => output);
  return Object.freeze({
    child,
    origin: targetOrigin,
    output: () => output,
    pid: child.pid,
    port: listenPort,
    turnstileNonce,
  });
}

async function waitForServer(server: ChildProcess, targetOrigin: string, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Next.js server exited before readiness.\n${output()}`);
    try {
      const response = await fetch(`${targetOrigin}/methodology`);
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
  if (value.includes(forbidden)) throw new Error(`${label} exposed a forbidden private marker.`);
}

function assertSitemapLastmod(sitemap: string, expectedLocation: string, expectedDatePrefix: string): void {
  const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => {
    const block = match[1] ?? "";
    return {
      lastmod: block.match(/<lastmod>([^<]+)<\/lastmod>/u)?.[1],
      location: block.match(/<loc>([^<]+)<\/loc>/u)?.[1]?.replaceAll("&amp;", "&"),
    };
  });
  const entry = entries.find((candidate) => candidate.location === expectedLocation);
  if (!entry) throw new Error(`Sitemap omitted ${expectedLocation}.`);
  if (!entry.lastmod?.startsWith(expectedDatePrefix)) {
    throw new Error(`Sitemap ${expectedLocation} lastmod was ${entry.lastmod ?? "missing"}; expected ${expectedDatePrefix}.`);
  }
}

function assertSingleCanonical(html: string, expectedCanonical: string, label: string): void {
  const canonicals = [...html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/giu)]
    .map((match) => match[1]?.replaceAll("&amp;", "&"));
  if (canonicals.length !== 1 || canonicals[0] !== expectedCanonical) {
    throw new Error(`${label} was ${JSON.stringify(canonicals)}; expected exactly ${expectedCanonical}.`);
  }
}

function assertPrivateDataAbsent(value: string, label: string): void {
  for (const sentinel of [
    ...privateSentinels,
    ...privateDemandSentinels,
    ...databaseSecretSentinels,
  ]) assertExcludes(value, sentinel, label);
  assertExcludes(value, "WP07_UNCITED_ALIAS_SENTINEL", label);
  assertExcludes(value, "WP07_PRIVATE_DESIGN_SENTINEL", label);
}

function assertReceiptDataAbsent(value: string, label: string): void {
  for (const receipt of privateReceiptSentinels) assertExcludes(value, receipt, label);
}

function assertClientBundleSafe(): void {
  const root = path.join(process.cwd(), ".next", "static");
  const forbidden = [
    ...privateSentinels,
    ...privateDemandSentinels,
    ...databaseSecretSentinels,
    ...privateReceiptSentinels,
    "WP07_UNCITED_ALIAS_SENTINEL",
    "WP07_PRIVATE_DESIGN_SENTINEL",
    "public_catalogue_fitments",
  ];
  for (const file of walkFiles(root)) {
    if (!file.endsWith(".js")) continue;
    const contents = readFileSync(file, "utf8");
    for (const marker of forbidden) {
      if (contents.includes(marker)) throw new Error(`Client bundle ${path.relative(process.cwd(), file)} exposed a forbidden private marker.`);
    }
  }
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

async function stopBuiltNextServer(server: RunningNextServer): Promise<void> {
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForChildExit(child, 5_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Built Next.js process ${server.pid} did not exit.`);
  }
  await waitForPortClosed(server.port);
}

async function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMilliseconds)),
  ]);
}

async function waitForPortClosed(listenPort: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await portIsOpen(listenPort))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Built Next.js port ${listenPort} remained open after process exit.`);
}

function portIsOpen(listenPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: listenPort });
    socket.setTimeout(250);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
