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
const CACHE_TAG_INVALIDATION_FAILURE_KIND = "CACHE_TAG_INVALIDATION_THROWN";

export interface CatalogueCacheTagFailure {
  tag: string;
  kind: typeof CACHE_TAG_INVALIDATION_FAILURE_KIND;
}

export interface CatalogueCacheInvalidationAttempt {
  affectedTags: readonly string[];
  completedTags: readonly string[];
  failedTags: readonly string[];
  retryTags: readonly string[];
  failures: readonly CatalogueCacheTagFailure[];
}

export class CatalogueCacheInvalidationError extends Error {
  readonly code = CACHE_INVALIDATION_ERROR_CODE;
  readonly mutationCommitted = true as const;
  readonly fitmentId: string;
  readonly affectedTags: readonly string[];
  readonly completedTags: readonly string[];
  readonly failedTags: readonly string[];
  readonly retryTags: readonly string[];
  readonly failures: readonly CatalogueCacheTagFailure[];

  constructor(fitmentId: string, attempt: CatalogueCacheInvalidationAttempt) {
    super(CACHE_INVALIDATION_ERROR_CODE);
    this.name = "CatalogueCacheInvalidationError";
    this.fitmentId = fitmentId;
    this.affectedTags = Object.freeze([...attempt.affectedTags]);
    this.completedTags = Object.freeze([...attempt.completedTags]);
    this.failedTags = Object.freeze([...attempt.failedTags]);
    this.retryTags = Object.freeze([...attempt.retryTags]);
    this.failures = Object.freeze(attempt.failures.map((failure) => Object.freeze({ ...failure })));
  }
}

export interface CatalogueCacheFailureDescription {
  status: 503;
  error: {
    code: typeof CACHE_INVALIDATION_ERROR_CODE;
    message: string;
    details: {
      mutationCommitted: true;
      cacheInvalidated: false;
      fitmentId: string;
      affectedTags: readonly string[];
      completedTags: readonly string[];
      failedTags: readonly string[];
      retryTags: readonly string[];
    };
  };
}

export function catalogTagsForContext(context: CatalogInvalidationContext): string[] {
  return stableUniqueTags([
    CATALOG_CACHE_TAG,
    CATALOG_INDEX_CACHE_TAG,
    ...context.modelPaths.map(({ brandSlug, modelSlug }) => modelCacheTag(brandSlug, modelSlug)),
    ...context.partSlugs.map(partCacheTag),
  ]);
}

export async function attemptCatalogueCacheInvalidation(
  inputTags: readonly string[],
): Promise<CatalogueCacheInvalidationAttempt> {
  const affectedTags = stableUniqueTags(inputTags);
  const completedTags: string[] = [];
  const failedTags: string[] = [];
  const failures: CatalogueCacheTagFailure[] = [];

  for (const tag of affectedTags) {
    try {
      await revalidateTag(tag, { expire: 0 });
      completedTags.push(tag);
    } catch {
      failedTags.push(tag);
      failures.push({ tag, kind: CACHE_TAG_INVALIDATION_FAILURE_KIND });
    }
  }

  return {
    affectedTags,
    completedTags,
    failedTags,
    retryTags: [...failedTags],
    failures,
  };
}

export async function invalidatePublicCatalogueForFitment(
  fitmentId: string,
): Promise<CatalogueCacheInvalidationAttempt> {
  const context = await getCatalogInvalidationContext(fitmentId);
  const affectedTags = catalogTagsForContext(context);
  return attemptCatalogueCacheInvalidation(affectedTags);
}

/**
 * Runs cache invalidation only after the database mutation resolves. Editorial
 * mutations own their transaction, so resolution means that transaction has
 * committed. A later cache failure must never be represented as a rollback.
 */
export async function runCatalogueMutationWithInvalidation<T extends { fitmentId: string }>(mutation: () => Promise<T>): Promise<T> {
  const result = await mutation();
  const attempt = await invalidatePublicCatalogueForFitment(result.fitmentId);

  if (attempt.failedTags.length > 0) {
    const error = new CatalogueCacheInvalidationError(result.fitmentId, attempt);
    console.error("Public catalogue cache invalidation failed after a committed database mutation.", {
      code: error.code,
      mutationCommitted: error.mutationCommitted,
      fitmentId: error.fitmentId,
      affectedTags: error.affectedTags,
      completedTags: error.completedTags,
      failedTags: error.failedTags,
      retryTags: error.retryTags,
      failures: error.failures,
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
        mutationCommitted: error.mutationCommitted,
        cacheInvalidated: false,
        fitmentId: error.fitmentId,
        affectedTags: error.affectedTags,
        completedTags: error.completedTags,
        failedTags: error.failedTags,
        retryTags: error.retryTags,
      },
    },
  };
}

function stableUniqueTags(tags: readonly string[]): string[] {
  return [...new Set(tags)];
}
