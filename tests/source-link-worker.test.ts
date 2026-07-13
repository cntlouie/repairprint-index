import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

import { POST, handleSourceLinkWorkerRequest } from "../src/app/api/internal/source-links/route";
import { runSourceLinkBatch, SourceLinkBatchError, type ClaimedSourceLinkJob, type SourceLinkWorkerDependencies } from "../src/lib/source-link-worker";
import { authorizeSourceWorker, parseSourceWorkerSecret } from "../src/lib/source-worker-auth";

const job = (id: string): ClaimedSourceLinkJob => ({
  jobId: id, sourceId: crypto.randomUUID(), leaseToken: crypto.randomUUID(),
  canonicalUrl: `https://example.com/${id}`, platform: "fixture",
});
const healthy = Object.freeze({ outcome: "healthy" as const, httpStatus: 200, finalUrl: "https://example.com/item", responseMs: 5, errorCode: null, redirectHops: 0, retryAfterAt: null });

function dependencies(overrides: Partial<SourceLinkWorkerDependencies> = {}): SourceLinkWorkerDependencies {
  return {
    claim: vi.fn().mockResolvedValue([job("one"), job("two")]),
    check: vi.fn().mockResolvedValue(healthy),
    complete: vi.fn().mockImplementation(async (claimed: ClaimedSourceLinkJob) => ({
      checkId: crypto.randomUUID(), affectedFitmentIds: claimed.jobId === "one" ? ["fitment-a", "fitment-a"] : [],
      publicationChanged: claimed.jobId === "one",
    })),
    invalidate: vi.fn().mockResolvedValue({ affectedTags: ["catalogue:all"], failedTags: [] }),
    ...overrides,
  };
}

describe("source link worker", () => {
  it("deduplicates committed fitments and invalidates only after completion", async () => {
    const harness = dependencies();
    const result = await runSourceLinkBatch("worker", crypto.randomUUID(), harness);
    expect(result).toEqual({ claimed: 2, completed: 2, affectedFitmentIds: ["fitment-a"], affectedTags: ["catalogue:all"] });
    expect(harness.invalidate).toHaveBeenCalledWith(["fitment-a"]);
  });

  it("performs no invalidation when database completion fails before commit", async () => {
    const harness = dependencies({ complete: vi.fn().mockRejectedValue(new Error("raw database detail")) });
    await expect(runSourceLinkBatch("worker", crypto.randomUUID(), harness)).rejects.toMatchObject({
      code: "SOURCE_LINK_BATCH_FAILED", mutationCommitted: false,
    });
    expect(harness.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates successful committed work even when another job fails", async () => {
    const harness = dependencies({
      complete: vi.fn().mockImplementation(async (claimed: ClaimedSourceLinkJob) => {
        if (claimed.jobId === "two") throw new Error("raw database detail");
        return { checkId: crypto.randomUUID(), affectedFitmentIds: ["fitment-a"], publicationChanged: true };
      }),
    });
    await expect(runSourceLinkBatch("worker", crypto.randomUUID(), harness)).rejects.toMatchObject({
      code: "SOURCE_LINK_BATCH_FAILED", mutationCommitted: true, affectedFitmentIds: ["fitment-a"],
    });
    expect(harness.invalidate).toHaveBeenCalledWith(["fitment-a"]);
  });

  it("surfaces sanitized post-commit cache failures", async () => {
    const harness = dependencies({ invalidate: vi.fn().mockResolvedValue({ affectedTags: ["catalogue:all", "catalogue:part:a"], failedTags: ["catalogue:part:a"] }) });
    const error = await runSourceLinkBatch("worker", crypto.randomUUID(), harness).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceLinkBatchError);
    expect(error).toMatchObject({
      code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
      affectedFitmentIds: ["fitment-a"], affectedTags: ["catalogue:all", "catalogue:part:a"], failedTags: ["catalogue:part:a"],
    });
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("sanitizes failures while computing post-commit cache context", async () => {
    const harness = dependencies({ invalidate: vi.fn().mockRejectedValue(new Error("raw catalogue database detail")) });
    await expect(runSourceLinkBatch("worker", crypto.randomUUID(), harness)).rejects.toMatchObject({
      code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
      affectedFitmentIds: ["fitment-a"], affectedTags: ["catalogue:all"], failedTags: ["catalogue:all"],
    });
  });
});

describe("source worker HTTP authentication", () => {
  const secret = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  it("requires strong exact secret material and constant-shape authorization", () => {
    expect(parseSourceWorkerSecret(secret)).toBe(secret);
    expect(() => parseSourceWorkerSecret(undefined)).toThrow("SOURCE_LINK_WORKER_SECRET_INVALID");
    expect(() => parseSourceWorkerSecret("0".repeat(64))).toThrow("SOURCE_LINK_WORKER_SECRET_INVALID");
    expect(() => parseSourceWorkerSecret("ab".repeat(32))).toThrow("SOURCE_LINK_WORKER_SECRET_INVALID");
    expect(authorizeSourceWorker(`Bearer ${secret}`, secret)).toBe(true);
    expect(authorizeSourceWorker(`Bearer ${"1".repeat(64)}`, secret)).toBe(false);
  });

  it("returns a private sanitized 401 before database or network work", async () => {
    const response = await POST(new NextRequest("https://repairprint.example/api/internal/source-links", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ error: { code: "SOURCE_LINK_WORKER_UNAUTHORIZED" } });
  });

  it("returns a safe post-commit 503 without raw exceptions", async () => {
    const prior = {
      secret: process.env.SOURCE_LINK_WORKER_SECRET,
      actor: process.env.SOURCE_LINK_WORKER_ACTOR_ID,
      worker: process.env.SOURCE_LINK_WORKER_ID,
    };
    process.env.SOURCE_LINK_WORKER_SECRET = secret;
    process.env.SOURCE_LINK_WORKER_ACTOR_ID = crypto.randomUUID();
    process.env.SOURCE_LINK_WORKER_ID = "test-worker";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await handleSourceLinkWorkerRequest(
        new NextRequest("https://repairprint.example/api/internal/source-links", {
          method: "POST", headers: { authorization: `Bearer ${secret}` },
        }),
        vi.fn().mockRejectedValue(new SourceLinkBatchError({
          code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
          affectedFitmentIds: ["fitment-a"], affectedTags: ["catalogue:all"], failedTags: ["catalogue:all"],
        })),
      );
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ error: { code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", details: {
        mutationCommitted: true, affectedFitmentIds: ["fitment-a"],
        affectedTags: ["catalogue:all"], failedTags: ["catalogue:all"],
      } } });
      expect(JSON.stringify(body)).not.toContain("raw");
      expect(consoleError).toHaveBeenCalledWith("Source link batch requires operator attention.", expect.objectContaining({
        code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
      }));
    } finally {
      consoleError.mockRestore();
      restoreEnvironment("SOURCE_LINK_WORKER_SECRET", prior.secret);
      restoreEnvironment("SOURCE_LINK_WORKER_ACTOR_ID", prior.actor);
      restoreEnvironment("SOURCE_LINK_WORKER_ID", prior.worker);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
