import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  getContext: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock("@/lib/catalog", () => ({
  CATALOG_CACHE_TAG: "catalogue:all",
  CATALOG_INDEX_CACHE_TAG: "catalogue:index",
  modelCacheTag: (brandSlug: string, modelSlug: string) => `catalogue:model:${brandSlug}:${modelSlug}`,
  partCacheTag: (slug: string) => `catalogue:part:${slug}`,
  getCatalogInvalidationContext: mocks.getContext,
}));

import {
  attemptCatalogueCacheInvalidation,
  CatalogueCacheInvalidationError,
  type CatalogueCacheInvalidationAttempt,
  describeCatalogueCacheFailure,
  invalidatePublicCatalogueForFitment,
  runCatalogueMutationWithInvalidation,
} from "@/lib/catalog-cache";

const invalidationContext = {
  modelPaths: [
    { brandSlug: "brand", modelSlug: "exact-model" },
    { brandSlug: "brand", modelSlug: "sibling-model" },
  ],
  partSlugs: ["canonical-part", "related-part"],
};

const affectedTags = [
  "catalogue:all",
  "catalogue:index",
  "catalogue:model:brand:exact-model",
  "catalogue:model:brand:sibling-model",
  "catalogue:part:canonical-part",
  "catalogue:part:related-part",
] as const;

describe("catalogue cache invalidation", () => {
  beforeEach(() => {
    mocks.revalidateTag.mockReset().mockResolvedValue(undefined);
    mocks.getContext.mockReset().mockResolvedValue(invalidationContext);
  });

  it("records every affected tag when all tags succeed", async () => {
    await expect(invalidatePublicCatalogueForFitment("fitment-id")).resolves.toEqual({
      affectedTags,
      completedTags: affectedTags,
      failedTags: [],
      retryTags: [],
      failures: [],
    });
    expect(mocks.getContext).toHaveBeenCalledWith("fitment-id");
    expect(attemptedTags()).toEqual(affectedTags);
  });

  it("returns the committed result after invalidating every affected tag", async () => {
    const result = { fitmentId: "fitment-id", publicationStatus: "published" as const };
    const mutation = vi.fn().mockResolvedValue(result);

    await expect(runCatalogueMutationWithInvalidation(mutation)).resolves.toBe(result);

    expect(mutation).toHaveBeenCalledOnce();
    expect(attemptedTags()).toEqual(affectedTags);
  });

  it.each([
    { label: "first tag fails", failedTags: [affectedTags[0]] },
    { label: "middle tag fails after earlier successes", failedTags: [affectedTags[2]] },
    { label: "last tag fails", failedTags: [affectedTags.at(-1)!] },
    { label: "more than one tag fails", failedTags: [affectedTags[1], affectedTags[4]] },
  ])("preserves complete progress when $label", async ({ failedTags }) => {
    const failures = new Set<string>(failedTags);
    mocks.revalidateTag.mockImplementation(async (tag: string) => {
      if (failures.has(tag)) throw new Error(`raw failure for ${tag}`);
    });

    const error = await captureCommittedMutationError();

    expect(error).toMatchObject({
      code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
      mutationCommitted: true,
      fitmentId: "committed-fitment",
      affectedTags,
      completedTags: affectedTags.filter((tag) => !failures.has(tag)),
      failedTags,
      retryTags: failedTags,
      failures: failedTags.map((tag) => ({ tag, kind: "CACHE_TAG_INVALIDATION_THROWN" })),
    });
    expect(attemptedTags()).toEqual(affectedTags);
    expect("invalidationCause" in error).toBe(false);
  });

  it("attempts later tags after an earlier tag fails", async () => {
    mocks.revalidateTag.mockImplementation(async (tag: string) => {
      if (tag === affectedTags[0]) throw new Error("first tag failed");
    });

    const attempt = await attemptCatalogueCacheInvalidation(affectedTags);

    expect(attempt.failedTags).toEqual([affectedTags[0]]);
    expect(attempt.completedTags).toEqual(affectedTags.slice(1));
    expect(attemptedTags()).toEqual(affectedTags);
  });

  it("attempts duplicate input tags once in stable first-occurrence order", async () => {
    const attempt = await attemptCatalogueCacheInvalidation([
      "catalogue:all",
      "catalogue:index",
      "catalogue:all",
      "catalogue:part:one",
      "catalogue:index",
      "catalogue:part:one",
    ]);

    expect(attempt.affectedTags).toEqual(["catalogue:all", "catalogue:index", "catalogue:part:one"]);
    expect(attempt.completedTags).toEqual(attempt.affectedTags);
    expect(attemptedTags()).toEqual(attempt.affectedTags);
  });

  it("logs the committed state, complete progress lists, and sanitized failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretFailure = Object.assign(new Error("postgres://operator:secret@example.invalid/cache"), {
      internal: { stack: "WP07_RAW_INTERNAL_STACK" },
    });
    mocks.revalidateTag.mockImplementation(async (tag: string) => {
      if (tag === affectedTags[1] || tag === affectedTags[4]) throw secretFailure;
    });

    try {
      await captureCommittedMutationError();

      expect(log).toHaveBeenCalledWith(
        "Public catalogue cache invalidation failed after a committed database mutation.",
        {
          code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
          mutationCommitted: true,
          fitmentId: "committed-fitment",
          affectedTags,
          completedTags: [affectedTags[0], affectedTags[2], affectedTags[3], affectedTags[5]],
          failedTags: [affectedTags[1], affectedTags[4]],
          retryTags: [affectedTags[1], affectedTags[4]],
          failures: [
            { tag: affectedTags[1], kind: "CACHE_TAG_INVALIDATION_THROWN" },
            { tag: affectedTags[4], kind: "CACHE_TAG_INVALIDATION_THROWN" },
          ],
        },
      );
      const serializedLog = JSON.stringify(log.mock.calls);
      expect(serializedLog).not.toContain("operator:secret");
      expect(serializedLog).not.toContain("WP07_RAW_INTERNAL_STACK");
    } finally {
      log.mockRestore();
    }
  });

  it("returns a safe HTTP 503 description with complete retry information", () => {
    const error = new CatalogueCacheInvalidationError("committed-fitment", partialAttempt());
    const description = describeCatalogueCacheFailure(error);

    expect(description).toEqual({
      status: 503,
      error: {
        code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
        message:
          "The database change was committed, but refreshing the public catalogue cache failed. Public pages may remain stale until an operator retries cache invalidation.",
        details: {
          mutationCommitted: true,
          cacheInvalidated: false,
          fitmentId: "committed-fitment",
          affectedTags,
          completedTags: [affectedTags[0], affectedTags[2], affectedTags[3], affectedTags[5]],
          failedTags: [affectedTags[1], affectedTags[4]],
          retryTags: [affectedTags[1], affectedTags[4]],
        },
      },
    });
    const serializedDescription = JSON.stringify(description);
    expect(serializedDescription).not.toContain("failures");
    expect(serializedDescription).not.toContain("cause");
    expect(serializedDescription).not.toContain("stack");
    expect(description?.error.message.toLowerCase()).toContain("committed");
    expect(description?.error.message.toLowerCase()).not.toContain("rolled back");
    expect(description?.error.message.toLowerCase()).not.toContain("rollback");
  });

  it("performs no invalidation when the database transaction fails", async () => {
    const transactionError = new Error("database transaction rolled back");
    const mutation = vi.fn().mockRejectedValue(transactionError);

    await expect(runCatalogueMutationWithInvalidation(mutation)).rejects.toBe(transactionError);

    expect(mutation).toHaveBeenCalledOnce();
    expect(mocks.getContext).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("retries only retryTags and does not repeat tags that already succeeded", async () => {
    const initialFailures = new Set<string>([affectedTags[1], affectedTags[4]]);
    mocks.revalidateTag.mockImplementation(async (tag: string) => {
      if (initialFailures.has(tag)) throw new Error("temporary cache failure");
    });
    const error = await captureCommittedMutationError();

    mocks.revalidateTag.mockReset().mockResolvedValue(undefined);
    const retry = await attemptCatalogueCacheInvalidation(error.retryTags);

    expect(retry).toEqual({
      affectedTags: [affectedTags[1], affectedTags[4]],
      completedTags: [affectedTags[1], affectedTags[4]],
      failedTags: [],
      retryTags: [],
      failures: [],
    });
    expect(attemptedTags()).toEqual([affectedTags[1], affectedTags[4]]);
  });

  it("does not relabel unrelated failures as post-commit cache failures", () => {
    expect(describeCatalogueCacheFailure(new Error("transaction failed"))).toBeNull();
  });
});

async function captureCommittedMutationError(): Promise<CatalogueCacheInvalidationError> {
  try {
    await runCatalogueMutationWithInvalidation(async () => ({ fitmentId: "committed-fitment" }));
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueCacheInvalidationError);
    return error as CatalogueCacheInvalidationError;
  }
  throw new Error("Expected cache invalidation to fail.");
}

function attemptedTags(): string[] {
  return mocks.revalidateTag.mock.calls.map(([tag]) => tag as string);
}

function partialAttempt(): CatalogueCacheInvalidationAttempt {
  return {
    affectedTags,
    completedTags: [affectedTags[0], affectedTags[2], affectedTags[3], affectedTags[5]],
    failedTags: [affectedTags[1], affectedTags[4]],
    retryTags: [affectedTags[1], affectedTags[4]],
    failures: [
      { tag: affectedTags[1], kind: "CACHE_TAG_INVALIDATION_THROWN" },
      { tag: affectedTags[4], kind: "CACHE_TAG_INVALIDATION_THROWN" },
    ],
  };
}
