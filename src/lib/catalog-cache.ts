import { revalidateTag } from "next/cache";

import type { CatalogInvalidationContext } from "./catalog-types";
import {
  CATALOG_CACHE_TAG,
  CATALOG_INDEX_CACHE_TAG,
  getCatalogInvalidationContext,
  modelCacheTag,
  partCacheTag,
} from "./catalog";

export function catalogTagsForContext(context: CatalogInvalidationContext): string[] {
  return [
    CATALOG_CACHE_TAG,
    CATALOG_INDEX_CACHE_TAG,
    ...context.modelPaths.map(({ brandSlug, modelSlug }) => modelCacheTag(brandSlug, modelSlug)),
    ...context.partSlugs.map(partCacheTag),
  ].filter((tag, index, tags) => tags.indexOf(tag) === index);
}

export async function invalidatePublicCatalogueForFitment(fitmentId: string): Promise<string[]> {
  const context = await getCatalogInvalidationContext(fitmentId);
  const tags = catalogTagsForContext(context);
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return tags;
}
