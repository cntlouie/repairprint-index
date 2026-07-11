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
  sources,
} from "../src/db/schema";
import { db } from "../src/db/client";

const ids = {
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
};

await db.insert(brands).values({ id: ids.brand, name: "DemoVac", slug: "demovac", normalizedName: "DEMOVAC" }).onConflictDoNothing();
await db.insert(categories).values({ id: ids.category, name: "Vacuum cleaners", slug: "vacuum-cleaners" }).onConflictDoNothing();
await db.insert(productModels).values({ id: ids.model, publicId: "mdl_demo_dv100", brandId: ids.brand, categoryId: ids.category, modelName: "DV-100", slug: "dv-100", marketCodes: ["DEMO"], summary: "Fictional seed record." }).onConflictDoNothing();
await db.insert(productIdentifiers).values({ productModelId: ids.model, displayValue: "DV-100", strictKey: "DV-100", looseKey: "DV100", identifierType: "label" }).onConflictDoNothing();
await db.insert(components).values({ id: ids.component, categoryId: ids.category, name: "Dust-bin latch", slug: "dust-bin-latch", commonNames: ["bin catch", "release latch"] }).onConflictDoNothing();
await db.insert(productComponents).values({ id: ids.productComponent, productModelId: ids.model, componentId: ids.component, mappingStatus: "accepted" }).onConflictDoNothing();
await db.insert(creators).values({ id: ids.creator, displayName: "Demo creator", platform: "example" }).onConflictDoNothing();
await db.insert(sources).values({ id: ids.source, sourceType: "demo", platform: "example", canonicalUrl: "https://example.com/demo-repairprint-source", title: "Fictional source record", retrievedAt: new Date("2026-07-01T00:00:00Z"), lastCheckedAt: new Date("2026-07-01T00:00:00Z") }).onConflictDoNothing();
await db.insert(designs).values({ id: ids.design, publicId: "dsn_demo_latch", slug: "demo-dv100-bin-latch", creatorId: ids.creator, title: "DV-100 dust-bin latch" }).onConflictDoNothing();
await db.insert(designRevisions).values({ id: ids.revision, designId: ids.design, sourceId: ids.source, sourceRevision: "r1", licenseCode: "CC-BY", attributionText: "DV-100 dust-bin latch by Demo creator, CC BY", fileFormats: ["STL"], rightsCheckedAt: new Date("2026-07-01T00:00:00Z") }).onConflictDoNothing();
await db.insert(fitments).values({ id: ids.fitment, publicId: "fit_demo_latch", slug: "demovac-dv100-bin-latch", designRevisionId: ids.revision, productComponentId: ids.productComponent, confidenceLevel: "verified_fit", confidenceScore: 100, publicationStatus: "draft", lastComputedAt: new Date() }).onConflictDoNothing();
await db.insert(fitmentEvidence).values({ id: ids.evidence, fitmentId: ids.fitment, evidenceKind: "trusted_physical_test", outcome: "fits_without_modification", exactModel: true, exactDesignRevision: true, hasInstalledPhoto: true, measurements: { note: "fictional" }, summary: "Fictional trusted-test evidence.", observedAt: "2026-07-01", moderationStatus: "accepted" }).onConflictDoNothing();
await db.insert(safetyReviews).values({ id: ids.safety, productComponentId: ids.productComponent, safetyClass: "low", signals: ["low_load_clip"], failureConsequence: "Inconvenience only", rationale: "Fictional low-load external latch." }).onConflictDoNothing();

console.log("Fictional development seed applied. No record is approved for public launch.");
