import { describe, expect, it } from "vitest";
import { evaluatePublishability } from "@/domain/publishability";

const complete = {
  fitmentStatus: "creator_listed" as const,
  safetyClass: "low" as const,
  sourcePolicy: "current_permitted" as const,
  originalLandingPageAvailable: true,
  creatorRecorded: true,
  attributionComplete: true,
  licenseRecorded: true,
  exactTargetRecorded: true,
  claimProvenanceComplete: true,
  safetyReviewed: true,
  openRightsOrSafetyNotice: false,
  designRevisionIdentified: true,
  designRevisionCurrent: true,
  fitmentRulesetVersion: "fitment-v1",
  safetyRulesetVersion: "safety-v1",
  sourceRetrievedAt: "2026-07-01",
  sourceLastCheckedAt: "2026-07-10",
};

describe("publication gate", () => {
  it("publishes and indexes a complete low-risk creator-listed record", () => {
    expect(evaluatePublishability(complete)).toEqual({
      publish: true,
      index: true,
      blockers: [],
      errorCodes: [],
    });
  });

  it("may publish but never index a candidate", () => {
    const result = evaluatePublishability({ ...complete, fitmentStatus: "candidate_match" });
    expect(result.publish).toBe(true);
    expect(result.index).toBe(false);
  });

  it("blocks caution records in the launch policy", () => {
    const result = evaluatePublishability({ ...complete, safetyClass: "caution" });
    expect(result.publish).toBe(false);
  });

  it("blocks unresolved disputes", () => {
    const result = evaluatePublishability({ ...complete, fitmentStatus: "disputed" });
    expect(result.publish).toBe(false);
    expect(result.errorCodes).toContain("FIT-003");
  });

  it.each([
    ["blocked source policy", { sourcePolicy: "blocked" }, "SRC-001"],
    ["stale source policy", { sourcePolicy: "stale" }, "SRC-001"],
    ["missing acquisition permission", { sourcePolicy: "permission_missing" }, "SRC-002"],
    ["unavailable landing page", { originalLandingPageAvailable: false }, "LINK-001"],
    ["missing creator", { creatorRecorded: false }, "RIGHTS-004"],
    ["incomplete attribution", { attributionComplete: false }, "RIGHTS-004"],
    ["missing licence state", { licenseRecorded: false }, "RIGHTS-001"],
    ["missing exact target", { exactTargetRecorded: false }, "FIT-001"],
    ["incomplete claim provenance", { claimProvenanceComplete: false }, "PROV-001"],
    ["missing retrieval date", { sourceRetrievedAt: undefined }, "PROV-001"],
    ["missing last-check date", { sourceLastCheckedAt: undefined }, "PROV-001"],
    ["missing safety review", { safetyReviewed: false }, "SAFE-002"],
    ["open notice", { openRightsOrSafetyNotice: true }, "UGC-003"],
    ["stale fitment rules", { fitmentRulesetVersion: "fitment-v0" }, "FIT-004"],
    ["stale safety rules", { safetyRulesetVersion: "safety-v0" }, "SAFE-004"],
    ["unidentified revision", { designRevisionIdentified: false }, "FIT-005"],
    ["non-current revision", { designRevisionCurrent: false }, "FIT-005"],
    ["rejected fitment", { fitmentStatus: "rejected" }, "FIT-002"],
  ] as const)("blocks %s", (_label, override, code) => {
    const result = evaluatePublishability({ ...complete, ...override });
    expect(result.publish).toBe(false);
    expect(result.errorCodes).toContain(code);
  });

  it("returns identical decisions for identical input", () => {
    expect(evaluatePublishability(structuredClone(complete))).toEqual(evaluatePublishability(complete));
  });

  it("keeps fitment and safety independent", () => {
    const result = evaluatePublishability({
      ...complete,
      fitmentStatus: "verified_fit",
      safetyClass: "blocked",
    });
    expect(result.publish).toBe(false);
    expect(result.errorCodes).toContain("SAFE-001");
  });
});
