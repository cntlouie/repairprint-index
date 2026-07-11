import { describe, expect, it } from "vitest";
import { evaluatePublishability } from "@/domain/publishability";

const complete = {
  fitmentStatus: "creator_listed" as const,
  safetyClass: "low" as const,
  sourceIsLive: true,
  creatorRecorded: true,
  licenseRecorded: true,
  exactTargetRecorded: true,
  safetyReviewed: true,
  sourceRetrievedAt: "2026-07-01",
  sourceLastCheckedAt: "2026-07-10",
};

describe("publication gate", () => {
  it("publishes and indexes a complete low-risk creator-listed record", () => {
    expect(evaluatePublishability(complete)).toEqual({ publish: true, index: true, blockers: [] });
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
  });
});
