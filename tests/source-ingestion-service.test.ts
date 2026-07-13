import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ingestAdapterCandidate, SourceIngestionError } from "../src/lib/source-ingestion-service";
import type { SourceAdapter } from "../src/lib/source-adapters";
import type { SourcePolicySnapshot } from "../src/domain/source-policy";
import { sourceContentChecksum } from "../src/domain/source-ingestion";

const now = new Date("2026-07-13T00:00:00.000Z");
const validPolicy: SourcePolicySnapshot = {
  reviewId: "00000000-0000-4000-8000-000000000902",
  platform: "thingiverse",
  policy: "written_permission",
  policyVersion: "review-2026-07",
  permissionScope: "review:review-2026-07",
  termsUrl: "https://example.invalid/terms",
  termsChecksum: "b".repeat(64),
  termsCheckedAt: new Date("2026-07-01T00:00:00.000Z"),
  expiresAt: new Date("2027-07-02T00:00:00.000Z"),
  allowedFields: ["external_id", "title"],
  automationAllowed: true,
  commercialUseAllowed: true,
  adapterEnabled: true,
  currentPolicyMatches: true,
};

const validPayload = { external_id: "42", title: "Fixture" };
function adapter(fetchCandidate = vi.fn().mockResolvedValue({
  externalId: "42",
  contentChecksum: sourceContentChecksum(validPayload),
  payload: validPayload,
  retrievedAt: now,
})): SourceAdapter {
  return { platform: "thingiverse", version: "fixture-v1", requestedFields: ["external_id", "title"], fetchCandidate };
}

describe("adapter ingestion boundary", () => {
  it.each([
    [null, "SOURCE_POLICY_MISSING"],
    [{ ...validPolicy, policy: "blocked" as const }, "SOURCE_POLICY_BLOCKED"],
    [{ ...validPolicy, adapterEnabled: false }, "SOURCE_POLICY_DISABLED"],
    [{ ...validPolicy, currentPolicyMatches: false }, "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
    [{ ...validPolicy, automationAllowed: false }, "SOURCE_AUTOMATION_FORBIDDEN"],
    [{ ...validPolicy, commercialUseAllowed: false }, "SOURCE_COMMERCIAL_USE_INCOMPATIBLE"],
    [{ ...validPolicy, expiresAt: new Date("2026-07-12T00:00:00.000Z") }, "SOURCE_POLICY_STALE"],
    [{ ...validPolicy, allowedFields: ["external_id"] }, "SOURCE_FIELD_NOT_ALLOWED"],
  ])("fails closed before fetch for %s", async (policy, code) => {
    const fetchCandidate = vi.fn();
    const persist = vi.fn();
    await expect(ingestAdapterCandidate({
      adapter: adapter(fetchCandidate), externalId: "42", policy, now,
      actorId: crypto.randomUUID(), requestId: "req_test", policyReviewId: validPolicy.reviewId, persist,
    })).rejects.toMatchObject({ code } satisfies Partial<SourceIngestionError>);
    expect(fetchCandidate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects platform and review-ID substitution before fetch", async () => {
    for (const input of [
      { sourceAdapter: { ...adapter(), platform: "makerworld" }, policyReviewId: validPolicy.reviewId, code: "SOURCE_POLICY_PLATFORM_MISMATCH" },
      { sourceAdapter: adapter(), policyReviewId: crypto.randomUUID(), code: "SOURCE_POLICY_REVIEW_MISMATCH" },
    ]) {
      const persist = vi.fn();
      await expect(ingestAdapterCandidate({
        adapter: input.sourceAdapter, externalId: "42", policy: validPolicy, now,
        actorId: crypto.randomUUID(), requestId: "req_identity", policyReviewId: input.policyReviewId, persist,
      })).rejects.toMatchObject({ code: input.code });
      expect(input.sourceAdapter.fetchCandidate).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    }
  });

  it("rejects forbidden or checksum-conflicting adapter output before persistence", async () => {
    for (const record of [
      { externalId: "42", payload: { external_id: "42", files: ["part.stl"] } },
      { externalId: "42", payload: { external_id: "42", title: { description: "nested" } } },
      { externalId: "other", payload: validPayload },
    ]) {
      const fetchCandidate = vi.fn().mockResolvedValue({
        ...record, contentChecksum: sourceContentChecksum(record.payload), retrievedAt: now,
      });
      const persist = vi.fn();
      await expect(ingestAdapterCandidate({
        adapter: adapter(fetchCandidate), externalId: "42", policy: validPolicy, now,
        actorId: crypto.randomUUID(), requestId: "req_payload", policyReviewId: validPolicy.reviewId, persist,
      })).rejects.toMatchObject({ code: "SOURCE_CANDIDATE_PAYLOAD_INVALID" });
      expect(persist).not.toHaveBeenCalled();
    }
  });

  it("fetches only after policy approval and persists a deterministic private identity", async () => {
    const sourceAdapter = adapter();
    const result = Object.freeze({
      runId: crypto.randomUUID(), candidateId: crypto.randomUUID(), versionId: crypto.randomUUID(),
      runCreated: true, candidateCreated: true, versionCreated: true,
    });
    const persist = vi.fn().mockResolvedValue(result);
    await expect(ingestAdapterCandidate({
      adapter: sourceAdapter, externalId: "42", policy: validPolicy, now,
      actorId: crypto.randomUUID(), requestId: "req_test", policyReviewId: validPolicy.reviewId, persist,
    })).resolves.toBe(result);
    expect(sourceAdapter.fetchCandidate).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      platform: "thingiverse", externalId: "42", contentChecksum: sourceContentChecksum(validPayload),
      allowedPayload: { external_id: "42", title: "Fixture" }, adapterVersion: "fixture-v1",
      policyReviewId: validPolicy.reviewId,
    }));
  });
});
