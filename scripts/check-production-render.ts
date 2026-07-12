import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import * as schema from "../src/db/schema";

const port = 3197;
const origin = `http://127.0.0.1:${port}`;
const privateSentinels = [
  "WP07_PRIVATE_RENDER_SENTINEL",
  "private-render@example.invalid",
  "postgres://",
  "postgresql://",
  "DATABASE_URL",
  "moderation_status",
  "reviewed_by",
  "supporting_excerpt",
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
} as const;

let databaseSecretSentinels: string[] = [];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;
  if (!databaseUrl && process.env.CI !== "true") {
    console.log("Production render check skipped locally: set DATABASE_TEST_URL to the guarded repairprint_test database.");
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_TEST_URL is required for the production render check in CI.");
  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");
  databaseSecretSentinels = [databaseUrl, encodeURIComponent(databaseUrl)];

  await prepareDatabase(databaseUrl);
  runProductionBuild(databaseUrl);
  await runHttpAssertions(databaseUrl);
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
      matchedEntityType: "design",
      matchedEntityId: ids.liveDesign,
      payload: {
        email: "private-render@example.invalid",
        notes: "WP07_PRIVATE_RENDER_SENTINEL",
        moderationNotes: "Never public",
      },
      reviewedBy: ids.reviewer,
      reviewedAt: now,
      resolvedAt: now,
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

function runProductionBuild(databaseUrl: string): void {
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: productionEnvironment(databaseUrl),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("Production-mode Next.js build failed during render integration.");
  }
  assertClientBundleSafe();
}

async function runHttpAssertions(databaseUrl: string): Promise<void> {
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: productionEnvironment(databaseUrl),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  server.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitForServer(server, () => output);

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

    console.log("Production render checks passed: model, canonical part, metadata, React payload, tombstone, redirect, 404, and privacy boundaries are valid.");
  } finally {
    await stopServer(server);
  }
}

function productionEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DEMO_MODE: "false",
    NEXT_PUBLIC_SITE_URL: origin,
    NEXT_TELEMETRY_DISABLED: "1",
  };
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
