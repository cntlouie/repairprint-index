import { describe, expect, it } from "vitest";
import { evaluateFitmentEvidence } from "@/domain/fitment";
import type { FitmentEvidence } from "@/domain/types";

function evidence(overrides: Partial<FitmentEvidence>): FitmentEvidence {
  return {
    id: crypto.randomUUID(),
    kind: "community_report",
    outcome: "fits_without_modification",
    moderationStatus: "accepted",
    exactModel: true,
    exactDesignRevision: true,
    reporterKey: crypto.randomUUID(),
    installedPhoto: false,
    measurements: false,
    observedAt: "2026-07-01",
    summary: "Fixture",
    ...overrides,
  };
}

describe("evaluateFitmentEvidence", () => {
  it("marks a trusted exact-revision physical test as verified", () => {
    const result = evaluateFitmentEvidence([evidence({ kind: "trusted_physical_test" })]);
    expect(result.status).toBe("verified_fit");
  });

  it("requires distinct reporters and a photo for community confirmation", () => {
    const result = evaluateFitmentEvidence([
      evidence({ reporterKey: "a", installedPhoto: true }),
      evidence({ reporterKey: "b" }),
    ]);
    expect(result.status).toBe("community_confirmed");
  });

  it("does not count a print failure as incompatibility", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "creator_claim", outcome: undefined, reporterKey: undefined }),
      evidence({ outcome: "print_failed" }),
    ]);
    expect(result.status).toBe("creator_listed");
  });

  it("lets an accepted exact-model incompatibility override positive evidence", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "trusted_physical_test" }),
      evidence({ outcome: "does_not_fit", reporterKey: "negative" }),
    ]);
    expect(result.status).toBe("disputed");
  });

  it("keeps OEM mappings as candidates", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "oem_mapping", outcome: undefined, exactDesignRevision: false, reporterKey: undefined }),
    ]);
    expect(result.status).toBe("candidate_match");
  });
});
