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
  CatalogueCacheInvalidationError,
  describeCatalogueCacheFailure,
  invalidatePublicCatalogueForFitment,
  runCatalogueMutationWithInvalidation,
} from "@/lib/catalog-cache";

describe("catalogue cache invalidation", () => {
  beforeEach(() => {
    mocks.revalidateTag.mockReset();
    mocks.getContext.mockReset();
  });

  it("expires every affected tag after a public fitment mutation", async () => {
    mocks.getContext.mockResolvedValue({
      modelPaths: [{ brandSlug: "brand", modelSlug: "exact-model" }],
      partSlugs: ["canonical-part", "related-part"],
    });

    await expect(invalidatePublicCatalogueForFitment("fitment-id")).resolves.toEqual([
      "catalogue:all",
      "catalogue:index",
      "catalogue:model:brand:exact-model",
      "catalogue:part:canonical-part",
      "catalogue:part:related-part",
    ]);
    expect(mocks.getContext).toHaveBeenCalledWith("fitment-id");
    expect(mocks.revalidateTag.mock.calls).toEqual([
      ["catalogue:all", { expire: 0 }],
      ["catalogue:index", { expire: 0 }],
      ["catalogue:model:brand:exact-model", { expire: 0 }],
      ["catalogue:part:canonical-part", { expire: 0 }],
      ["catalogue:part:related-part", { expire: 0 }],
    ]);
  });

  it("does not invalidate when the database transaction fails", async () => {
    const transactionError = new Error("database transaction rolled back");
    const mutation = vi.fn().mockRejectedValue(transactionError);

    await expect(runCatalogueMutationWithInvalidation(mutation)).rejects.toBe(transactionError);

    expect(mutation).toHaveBeenCalledOnce();
    expect(mocks.getContext).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("returns the committed result after invalidating every affected tag", async () => {
    const result = { fitmentId: "fitment-id", publicationStatus: "published" as const };
    const mutation = vi.fn().mockResolvedValue(result);
    mocks.getContext.mockResolvedValue({
      modelPaths: [
        { brandSlug: "brand", modelSlug: "exact-model" },
        { brandSlug: "brand", modelSlug: "sibling-model" },
      ],
      partSlugs: ["canonical-part", "related-part"],
    });

    await expect(runCatalogueMutationWithInvalidation(mutation)).resolves.toBe(result);

    expect(mocks.revalidateTag.mock.calls).toEqual([
      ["catalogue:all", { expire: 0 }],
      ["catalogue:index", { expire: 0 }],
      ["catalogue:model:brand:exact-model", { expire: 0 }],
      ["catalogue:model:brand:sibling-model", { expire: 0 }],
      ["catalogue:part:canonical-part", { expire: 0 }],
      ["catalogue:part:related-part", { expire: 0 }],
    ]);
  });

  it("surfaces and logs cache failure after the database transaction commits", async () => {
    const invalidationError = new Error("cache backend unavailable");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getContext.mockResolvedValue({ modelPaths: [], partSlugs: [] });
    mocks.revalidateTag.mockImplementationOnce(() => {
      throw invalidationError;
    });

    let caught: unknown;
    try {
      await runCatalogueMutationWithInvalidation(async () => ({ fitmentId: "committed-fitment" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CatalogueCacheInvalidationError);
    expect(caught).toMatchObject({
      code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
      fitmentId: "committed-fitment",
      invalidationCause: invalidationError,
    });
    expect(log).toHaveBeenCalledWith(
      "Public catalogue cache invalidation failed after a committed database mutation.",
      expect.objectContaining({
        code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
        fitmentId: "committed-fitment",
        databaseMutationCommitted: true,
        cause: { name: "Error", message: "cache backend unavailable" },
      }),
    );
    log.mockRestore();
  });

  it("describes post-commit cache failure without claiming a database rollback", () => {
    const description = describeCatalogueCacheFailure(
      new CatalogueCacheInvalidationError("committed-fitment", new Error("cache backend unavailable")),
    );

    expect(description).toEqual({
      status: 503,
      error: {
        code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
        message:
          "The database change was committed, but refreshing the public catalogue cache failed. Public pages may remain stale until an operator retries cache invalidation.",
        details: {
          databaseMutationCommitted: true,
          cacheInvalidated: false,
          fitmentId: "committed-fitment",
        },
      },
    });
    expect(description?.error.message.toLowerCase()).toContain("committed");
    expect(description?.error.message.toLowerCase()).not.toContain("rolled back");
    expect(description?.error.message.toLowerCase()).not.toContain("rollback");
  });

  it("does not relabel unrelated failures as post-commit cache failures", () => {
    expect(describeCatalogueCacheFailure(new Error("transaction failed"))).toBeNull();
  });
});
