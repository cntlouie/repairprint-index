import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  getContext: vi.fn(),
  authorize: vi.fn(),
  parseBody: vi.fn(),
  publish: vi.fn(),
  moderateEvidence: vi.fn(),
  archive: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock("@/lib/catalog", () => ({
  CATALOG_CACHE_TAG: "catalogue:all",
  CATALOG_INDEX_CACHE_TAG: "catalogue:index",
  modelCacheTag: (brandSlug: string, modelSlug: string) => `catalogue:model:${brandSlug}:${modelSlug}`,
  partCacheTag: (slug: string) => `catalogue:part:${slug}`,
  getCatalogInvalidationContext: mocks.getContext,
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/editorial", () => ({
  publishCreatorSubmission: mocks.publish,
  moderateEvidence: mocks.moderateEvidence,
  archiveFitment: mocks.archive,
}));
vi.mock("@/lib/admin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-api")>();
  return {
    ...actual,
    authorizeAdminRequest: mocks.authorize,
    parseAdminBody: mocks.parseBody,
  };
});

import { POST as publishCase } from "@/app/api/admin/cases/[id]/publish/route";
import { POST as moderateEvidence } from "@/app/api/admin/evidence/[id]/route";
import { POST as archiveFitment } from "@/app/api/admin/fitments/[id]/archive/route";

const affectedTags = [
  "catalogue:all",
  "catalogue:index",
  "catalogue:model:brand:exact-model",
  "catalogue:part:canonical-part",
] as const;

const routeCases = [
  { label: "publish", path: "/api/admin/cases/case-id/publish", handler: publishCase, mutation: mocks.publish },
  { label: "evidence", path: "/api/admin/evidence/evidence-id", handler: moderateEvidence, mutation: mocks.moderateEvidence },
  { label: "archive", path: "/api/admin/fitments/fitment-id/archive", handler: archiveFitment, mutation: mocks.archive },
] as const;

describe("admin catalogue cache failure responses", () => {
  beforeEach(() => {
    mocks.revalidateTag.mockReset().mockImplementation(async (tag: string) => {
      if (tag === affectedTags[2]) {
        const error = new Error("postgres://operator:secret@example.invalid/cache");
        error.stack = "WP07_RAW_CACHE_STACK";
        throw error;
      }
    });
    mocks.getContext.mockReset().mockResolvedValue({
      modelPaths: [{ brandSlug: "brand", modelSlug: "exact-model" }],
      partSlugs: ["canonical-part"],
    });
    mocks.authorize.mockReset().mockResolvedValue({ id: "staff-id", role: "reviewer" });
    mocks.parseBody.mockReset().mockResolvedValue({ reason: "Reviewed cache contract fixture." });
    for (const mutation of [mocks.publish, mocks.moderateEvidence, mocks.archive]) {
      mutation.mockReset().mockResolvedValue({ fitmentId: "committed-fitment" });
    }
  });

  it.each(routeCases)("$label returns the safe structured HTTP 503 contract", async ({ path, handler, mutation }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req_cache_contract" },
      body: "{}",
    });

    try {
      const response = await handler(request, { params: Promise.resolve({ id: "fixture-id" }) });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(body).toEqual({
        error: {
          code: "CATALOGUE_CACHE_INVALIDATION_FAILED",
          message:
            "The database change was committed, but refreshing the public catalogue cache failed. Public pages may remain stale until an operator retries cache invalidation.",
          details: {
            mutationCommitted: true,
            cacheInvalidated: false,
            fitmentId: "committed-fitment",
            affectedTags,
            completedTags: [affectedTags[0], affectedTags[1], affectedTags[3]],
            failedTags: [affectedTags[2]],
            retryTags: [affectedTags[2]],
          },
          requestId: "req_cache_contract",
        },
      });
      const serializedBody = JSON.stringify(body);
      expect(serializedBody).not.toContain("operator:secret");
      expect(serializedBody).not.toContain("WP07_RAW_CACHE_STACK");
      expect(serializedBody).not.toContain("failures");
      expect(serializedBody).not.toContain("cause");
      expect(mutation).toHaveBeenCalledOnce();
      expect(mocks.revalidateTag.mock.calls.map(([tag]) => tag)).toEqual(affectedTags);
    } finally {
      log.mockRestore();
    }
  });
});
