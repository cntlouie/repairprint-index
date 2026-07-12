import { revalidateTag } from "next/cache";

import type { CatalogInvalidationContext } from "./catalog-types";
import {
  CATALOG_CACHE_TAG,
  CATALOG_INDEX_CACHE_TAG,
  getCatalogInvalidationContext,
  modelCacheTag,
  partCacheTag,
} from "./catalog";

const CACHE_INVALIDATION_ERROR_CODE = "CATALOGUE_CACHE_INVALIDATION_FAILED";
const CACHE_INVALIDATION_ERROR_MESSAGE =
  "The database change was committed, but refreshing the public catalogue cache failed. Public pages may remain stale until an operator retries cache invalidation.";

export class CatalogueCacheInvalidationError extends Error {
  readonly code = CACHE_INVALIDATION_ERROR_CODE;
  readonly fitmentId: string;
  readonly invalidationCause: unknown;

  constructor(fitmentId: string, cause: unknown) {
    super(CACHE_INVALIDATION_ERROR_CODE);
    this.name = "CatalogueCacheInvalidationError";
    this.fitmentId = fitmentId;
    this.invalidationCause = cause;
  }
}

export interface CatalogueCacheFailureDescription {
  status: 503;
  error: {
    code: typeof CACHE_INVALIDATION_ERROR_CODE;
    message: string;
    details: {
      databaseMutationCommitted: true;
      cacheInvalidated: false;
      fitmentId: string;
    };
  };
}

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

/**
 * Runs cache invalidation only after the database mutation resolves. Editorial
 * mutations own their transaction, so resolution means that transaction has
 * committed. A later cache failure must never be represented as a rollback.
 */
export async function runCatalogueMutationWithInvalidation<T extends { fitmentId: string }>(mutation: () => Promise<T>): Promise<T> {
  const result = await mutation();

  try {
    await invalidatePublicCatalogueForFitment(result.fitmentId);
  } catch (cause) {
    const error = new CatalogueCacheInvalidationError(result.fitmentId, cause);
    console.error("Public catalogue cache invalidation failed after a committed database mutation.", {
      code: error.code,
      fitmentId: error.fitmentId,
      databaseMutationCommitted: true,
      cause: describeCause(cause),
    });
    throw error;
  }

  return result;
}

export function describeCatalogueCacheFailure(error: unknown): CatalogueCacheFailureDescription | null {
  if (!(error instanceof CatalogueCacheInvalidationError)) return null;

  return {
    status: 503,
    error: {
      code: CACHE_INVALIDATION_ERROR_CODE,
      message: CACHE_INVALIDATION_ERROR_MESSAGE,
      details: {
        databaseMutationCommitted: true,
        cacheInvalidated: false,
        fitmentId: error.fitmentId,
      },
    },
  };
}

function describeCause(cause: unknown): { name: string; message: string } | string {
  return cause instanceof Error ? { name: cause.name, message: cause.message } : String(cause);
}
