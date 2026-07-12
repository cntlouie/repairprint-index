import { unstable_cache } from "next/cache";

import type {
  CatalogInvalidationContext,
  CatalogModel,
  CatalogPartLookup,
  CatalogPartSummary,
} from "./catalog-types";

export const CATALOG_CACHE_TAG = "catalogue:all";
export const CATALOG_INDEX_CACHE_TAG = "catalogue:index";

export function modelCacheTag(brandSlug: string, modelSlug: string): string {
  return `catalogue:model:${brandSlug}:${modelSlug}`;
}

export function partCacheTag(slug: string): string {
  return `catalogue:part:${slug}`;
}

export function productionCatalogueEnabled(): boolean {
  return process.env.DEMO_MODE === "false";
}

export async function listModels(limit = 24): Promise<CatalogModel[]> {
  if (!productionCatalogueEnabled()) return [];
  return unstable_cache(
    async () => import("@/db/catalog").then((catalogue) => catalogue.listPublishedModelsFromDatabase(limit)),
    ["public-catalogue-models", String(limit)],
    { tags: [CATALOG_CACHE_TAG, CATALOG_INDEX_CACHE_TAG], revalidate: 3600 },
  )();
}

export async function listRecentParts(limit = 12): Promise<CatalogPartSummary[]> {
  if (!productionCatalogueEnabled()) return [];
  return unstable_cache(
    async () => import("@/db/catalog").then((catalogue) => catalogue.listRecentPublishedPartsFromDatabase(limit)),
    ["public-catalogue-recent-parts", String(limit)],
    { tags: [CATALOG_CACHE_TAG, CATALOG_INDEX_CACHE_TAG], revalidate: 3600 },
  )();
}

export async function getModel(brandSlug: string, modelSlug: string): Promise<CatalogModel | null> {
  if (!productionCatalogueEnabled()) return null;
  return unstable_cache(
    async () => import("@/db/catalog").then((catalogue) => catalogue.getPublishedModelFromDatabase(brandSlug, modelSlug)),
    ["public-catalogue-model", brandSlug, modelSlug],
    { tags: [CATALOG_CACHE_TAG, modelCacheTag(brandSlug, modelSlug)], revalidate: 3600 },
  )();
}

export async function getPartsForModel(model: CatalogModel): Promise<CatalogPartSummary[]> {
  if (!productionCatalogueEnabled()) return [];
  return unstable_cache(
    async () => import("@/db/catalog").then((catalogue) => catalogue.listPublishedPartsForModelFromDatabase(model.id)),
    ["public-catalogue-model-parts", model.id],
    { tags: [CATALOG_CACHE_TAG, modelCacheTag(model.brandSlug, model.modelSlug)], revalidate: 3600 },
  )();
}

export async function getPart(slug: string): Promise<CatalogPartLookup> {
  if (!productionCatalogueEnabled()) return { kind: "not_found" };
  return unstable_cache(
    async () => import("@/db/catalog").then((catalogue) => catalogue.getPublishedPartFromDatabase(slug)),
    ["public-catalogue-part", slug],
    { tags: [CATALOG_CACHE_TAG, partCacheTag(slug)], revalidate: 3600 },
  )();
}

export async function getCatalogInvalidationContext(fitmentId: string): Promise<CatalogInvalidationContext> {
  return import("@/db/catalog").then((catalogue) => catalogue.getCatalogInvalidationContextFromDatabase(fitmentId));
}
