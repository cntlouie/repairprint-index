import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ingestAdapterCandidate, SourceIngestionError } from "../src/lib/source-ingestion-service";
import type { SourceAdapter } from "../src/lib/source-adapters";
import type { SourcePolicySnapshot } from "../src/domain/source-policy";

const now = new Date("2026-07-13T00:00:00.000Z");
const validPolicy: SourcePolicySnapshot = {
  platform: "thingiverse",
  policy: "written_permission",
  policyVersion: "review-2026-07",
  termsCheckedAt: new Date("2026-07-01T00:00:00.000Z"),
  expiresAt: new Date("2027-07-02T00:00:00.000Z"),
  allowedFields: ["external_id", "title"],
  automationAllowed: true,
  commercialUseAllowed: true,
  adapterEnabled: true,
  currentPolicyMatches: true,
};

function adapter(fetchCandidate = vi.fn().mockResolvedValue({
  externalId: "42",
  contentChecksum: "a".repeat(64),
  payload: { external_id: "42", title: "Fixture" },
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
      actorId: crypto.randomUUID(), requestId: "req_test", policyReviewId: crypto.randomUUID(), persist,
    })).rejects.toMatchObject({ code } satisfies Partial<SourceIngestionError>);
    expect(fetchCandidate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
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
      actorId: crypto.randomUUID(), requestId: "req_test", policyReviewId: crypto.randomUUID(), persist,
    })).resolves.toBe(result);
    expect(sourceAdapter.fetchCandidate).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      platform: "thingiverse", externalId: "42", contentChecksum: "a".repeat(64),
      allowedPayload: { external_id: "42", title: "Fixture" }, adapterVersion: "fixture-v1",
    }));
  });
});
