import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  brands,
  categories,
  components,
  creators,
  designRevisions,
  designs,
  fitmentEvidence,
  fitments,
  productComponents,
  productIdentifiers,
  productModels,
  safetyReviews,
  sourcePlatformPolicies,
  sources,
} from "../src/db/schema";
import * as schema from "../src/db/schema";

export const seedIds = {
  brand: "00000000-0000-4000-8000-000000000001",
  category: "00000000-0000-4000-8000-000000000002",
  model: "00000000-0000-4000-8000-000000000003",
  component: "00000000-0000-4000-8000-000000000004",
  productComponent: "00000000-0000-4000-8000-000000000005",
  creator: "00000000-0000-4000-8000-000000000006",
  source: "00000000-0000-4000-8000-000000000007",
  design: "00000000-0000-4000-8000-000000000008",
  revision: "00000000-0000-4000-8000-000000000009",
  fitment: "00000000-0000-4000-8000-000000000010",
  evidence: "00000000-0000-4000-8000-000000000011",
  safety: "00000000-0000-4000-8000-000000000012",
} as const;

type Database = PostgresJsDatabase<typeof schema>;

export async function seedDatabase(database: Database): Promise<void> {
  await database
    .insert(brands)
    .values({ id: seedIds.brand, name: "DemoVac", slug: "demovac", normalizedName: "DEMOVAC" })
    .onConflictDoNothing();
  await database
    .insert(categories)
    .values({ id: seedIds.category, name: "Vacuum cleaners", slug: "vacuum-cleaners" })
    .onConflictDoNothing();
  await database
    .insert(productModels)
    .values({
      id: seedIds.model,
      publicId: "mdl_demo_dv100",
      brandId: seedIds.brand,
      categoryId: seedIds.category,
      modelName: "DV-100",
      slug: "dv-100",
      marketCodes: ["DEMO"],
      summary: "Fictional seed record.",
    })
    .onConflictDoNothing();
  await database
    .insert(productIdentifiers)
    .values({
      productModelId: seedIds.model,
      displayValue: "DV-100",
      strictKey: "DV-100",
      looseKey: "DV100",
      identifierType: "label",
    })
    .onConflictDoNothing();
  await database
    .insert(components)
    .values({
      id: seedIds.component,
      categoryId: seedIds.category,
      name: "Dust-bin latch",
      slug: "dust-bin-latch",
      commonNames: ["bin catch", "release latch"],
    })
    .onConflictDoNothing();
  await database
    .insert(productComponents)
    .values({
      id: seedIds.productComponent,
      productModelId: seedIds.model,
      componentId: seedIds.component,
      mappingStatus: "accepted",
    })
    .onConflictDoNothing();
  await database
    .insert(creators)
    .values({ id: seedIds.creator, displayName: "Demo creator", platform: "example" })
    .onConflictDoNothing();
  await database
    .insert(sourcePlatformPolicies)
    .values({
      platform: "example.invalid",
      policy: "creator_submission",
      termsUrl: "https://example.invalid/fictional-terms",
      termsChecksum: "0f".repeat(32),
      termsCheckedAt: new Date("2026-07-11T00:00:00Z"),
      permissionScope: "Fictional manual-submission fixture only.",
      allowedFields: ["landing_page_url", "creator_name", "title", "claimed_compatibility", "license_state"],
      imageReuseAllowed: false,
      fileRehostingAllowed: false,
      automationAllowed: false,
      commercialUseAllowed: null,
      adapterEnabled: false,
    })
    .onConflictDoNothing();
  await database
    .insert(sources)
    .values({
      id: seedIds.source,
      sourceType: "demo",
      platform: "example",
      canonicalUrl: "https://example.com/demo-repairprint-source",
      title: "Fictional source record",
      retrievedAt: new Date("2026-07-01T00:00:00Z"),
      lastCheckedAt: new Date("2026-07-01T00:00:00Z"),
    })
    .onConflictDoNothing();
  await database
    .insert(designs)
    .values({
      id: seedIds.design,
      publicId: "dsn_demo_latch",
      slug: "demo-dv100-bin-latch",
      creatorId: seedIds.creator,
      title: "DV-100 dust-bin latch",
    })
    .onConflictDoNothing();
  await database
    .insert(designRevisions)
    .values({
      id: seedIds.revision,
      designId: seedIds.design,
      sourceId: seedIds.source,
      sourceRevision: "r1",
      licenseCode: "CC-BY",
      attributionText: "DV-100 dust-bin latch by Demo creator, CC BY",
      fileFormats: ["STL"],
      rightsCheckedAt: new Date("2026-07-01T00:00:00Z"),
    })
    .onConflictDoNothing();
  await database
    .insert(fitments)
    .values({
      id: seedIds.fitment,
      publicId: "fit_demo_latch",
      slug: "demovac-dv100-bin-latch",
      designRevisionId: seedIds.revision,
      productComponentId: seedIds.productComponent,
      confidenceLevel: "verified_fit",
      confidenceScore: 100,
      publicationStatus: "draft",
      lastComputedAt: new Date("2026-07-01T00:00:00Z"),
    })
    .onConflictDoNothing();
  await database
    .insert(fitmentEvidence)
    .values({
      id: seedIds.evidence,
      fitmentId: seedIds.fitment,
      evidenceKind: "trusted_physical_test",
      outcome: "fits_without_modification",
      exactModel: true,
      exactDesignRevision: true,
      hasInstalledPhoto: true,
      measurements: { note: "fictional" },
      summary: "Fictional trusted-test evidence.",
      observedAt: "2026-07-01",
      moderationStatus: "accepted",
    })
    .onConflictDoNothing();
  await database
    .insert(safetyReviews)
    .values({
      id: seedIds.safety,
      productComponentId: seedIds.productComponent,
      safetyClass: "low",
      signals: ["low_load_clip"],
      failureConsequence: "Inconvenience only",
      rationale: "Fictional low-load external latch.",
    })
    .onConflictDoNothing();
}
