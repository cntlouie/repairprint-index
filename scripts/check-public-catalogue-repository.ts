import {
  getCatalogInvalidationContextFromDatabase,
  getPublishedModelFromDatabase,
  getPublishedPartFromDatabase,
  listPublishedPartsForModelFromDatabase,
  listRecentPublishedPartsFromDatabase,
} from "../src/db/catalog";
import { closeDatabase } from "../src/db/client";

async function main(): Promise<void> {
  const brandSlug = required("WP07_TEST_BRAND_SLUG");
  const modelSlug = required("WP07_TEST_MODEL_SLUG");
  const canonicalSlug = required("WP07_TEST_CANONICAL_SLUG");
  const alternateSlug = required("WP07_TEST_ALTERNATE_SLUG");
  const fitmentId = required("WP07_TEST_FITMENT_ID");

  try {
    const model = await getPublishedModelFromDatabase(brandSlug, modelSlug);
    if (!model) throw new Error("Server catalogue repository did not resolve the published exact model.");

    const modelParts = await listPublishedPartsForModelFromDatabase(model.id);
    if (modelParts.length !== 2 || modelParts.some((part) => part.slug !== canonicalSlug)) {
      throw new Error(`Exact-model repository query returned the wrong revision set: ${JSON.stringify(modelParts)}.`);
    }

    const recentParts = await listRecentPublishedPartsFromDatabase(20);
    const canonicalSummaries = recentParts.filter((part) => part.slug === canonicalSlug);
    if (canonicalSummaries.length !== 1) {
      throw new Error("Catalogue index did not deduplicate exact edges onto one canonical part summary.");
    }

    const canonical = await getPublishedPartFromDatabase(canonicalSlug);
    if (canonical.kind !== "published" || canonical.part.fitments.length !== 3) {
      throw new Error(`Canonical part repository query did not preserve all exact edges: ${JSON.stringify(canonical)}.`);
    }
    const serialized = JSON.stringify(canonical);
    if (serialized.includes("WP07_PRIVATE_SUBMISSION_SENTINEL") || serialized.includes("private-catalogue@example.invalid")) {
      throw new Error("Private submission information reached the server catalogue response.");
    }
    const revisionTwo = canonical.part.fitments.find((fitment) => fitment.revision.label === "r2");
    if (!revisionTwo?.evidence.some((evidence) => evidence.summary === "WP-07_REGION_A_REVISION_TWO_EVIDENCE")) {
      throw new Error("The server catalogue response lost revision-specific evidence.");
    }
    const modelStatuses = new Map(canonical.part.fitments.map((fitment) => [fitment.model.modelSlug, fitment.status]));
    if (modelStatuses.get(modelSlug) !== "creator_listed" || modelStatuses.get("dv-100-region-b") !== "verified_fit") {
      throw new Error("The server catalogue response collapsed different exact-model fitment labels.");
    }

    const alternate = await getPublishedPartFromDatabase(alternateSlug);
    if (alternate.kind !== "redirect" || alternate.location !== `/parts/${canonicalSlug}`) {
      throw new Error("A noncanonical eligible slug did not redirect once to the canonical part page.");
    }

    const invalidation = await getCatalogInvalidationContextFromDatabase(fitmentId);
    if (!invalidation.modelPaths.some((path) => path.brandSlug === brandSlug && path.modelSlug === modelSlug)
      || !invalidation.partSlugs.includes(canonicalSlug)
      || !invalidation.partSlugs.includes(alternateSlug)) {
      throw new Error(`Cache invalidation context omitted an affected catalogue page: ${JSON.stringify(invalidation)}.`);
    }

    console.log("Public catalogue repository checks passed: exact model, revisions, canonical part, privacy, redirect, and invalidation queries are valid.");
  } finally {
    await closeDatabase();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the guarded catalogue repository check.`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
