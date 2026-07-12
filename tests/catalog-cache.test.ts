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

import { invalidatePublicCatalogueForFitment } from "@/lib/catalog-cache";

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
});
