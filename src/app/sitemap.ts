import type { MetadataRoute } from "next";
import { INDEXABLE_TRUST_PATHS } from "@/domain/seo";
import { POLICY_LAST_REVIEWED_ISO } from "@/components/PolicyStatus";
import { catalogModelMaterialUpdatedAt, modelCatalogueSeoFacts, partCatalogueSeoFacts } from "@/lib/catalog-seo";
import { currentSeoPage, currentSeoRuntime } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const runtime = currentSeoRuntime();
  if (!runtime.indexingAllowed || !runtime.origin) return [];
  const {
    getPublishedPartFromDatabase,
    listPublishedModelsFromDatabase,
    listPublishedPartsForModelFromDatabase,
    listRecentPublishedPartsFromDatabase,
  } = await import("@/db/catalog");

  const entries: MetadataRoute.Sitemap = [];
  const home = currentSeoPage("/");
  const trustEntries = INDEXABLE_TRUST_PATHS.flatMap((path) => {
    const decision = currentSeoPage(path);
    return decision.sitemapEligible && decision.canonicalUrl
      ? [{ url: decision.canonicalUrl, lastModified: POLICY_LAST_REVIEWED_ISO, changeFrequency: "monthly" as const, priority: 0.5 }]
      : [];
  });

  let models: Awaited<ReturnType<typeof listPublishedModelsFromDatabase>> = [];
  let partSummaries: Awaited<ReturnType<typeof listRecentPublishedPartsFromDatabase>> = [];
  try {
    [models, partSummaries] = await Promise.all([
      listPublishedModelsFromDatabase(100),
      listRecentPublishedPartsFromDatabase(250),
    ]);
  } catch {
    // Static public pages remain safe; catalogue entries fail closed.
  }

  const modelEntries = (await Promise.all(models.map(async (model) => {
    const path = `/brands/${model.brandSlug}/${model.modelSlug}`;
    const parts = await listPublishedPartsForModelFromDatabase(model.id);
    const decision = currentSeoPage(path, { catalogue: modelCatalogueSeoFacts(model, parts) });
    return decision.sitemapEligible && decision.canonicalUrl
      ? { url: decision.canonicalUrl, lastModified: catalogModelMaterialUpdatedAt(model, parts), changeFrequency: "weekly" as const, priority: 0.8 }
      : null;
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const partEntries = (await Promise.all([...new Map(partSummaries.map((part) => [part.slug, part])).values()].map(async (summary) => {
    const lookup = await getPublishedPartFromDatabase(summary.slug);
    if (lookup.kind !== "published") return null;
    const path = `/parts/${lookup.part.canonicalSlug}`;
    const decision = currentSeoPage(path, { catalogue: partCatalogueSeoFacts(lookup.part) });
    return decision.sitemapEligible && decision.canonicalUrl
      ? { url: decision.canonicalUrl, lastModified: lookup.part.updatedAt, changeFrequency: "monthly" as const, priority: 0.8 }
      : null;
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const homeMaterialDates = [
    ...models.slice(0, 24).map((model) => model.updatedAt),
    ...partSummaries.slice(0, 12).map((part) => part.updatedAt),
  ];
  if (home.sitemapEligible && home.canonicalUrl) {
    entries.push({
      url: home.canonicalUrl,
      ...(homeMaterialDates.length > 0 ? { lastModified: latestMaterialDate(homeMaterialDates) } : {}),
      changeFrequency: "weekly",
      priority: 1,
    });
  }
  entries.push(...trustEntries, ...modelEntries, ...partEntries);
  return [...new Map(entries.map((entry) => [entry.url, entry])).values()];
}

function latestMaterialDate(values: readonly (string | Date | undefined)[]): string {
  const timestamps = values
    .map((value) => value instanceof Date ? value.getTime() : Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return new Date(Math.max(...timestamps)).toISOString();
}
