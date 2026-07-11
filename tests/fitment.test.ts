import { describe, expect, it } from "vitest";
import { evaluateFitmentEvidence } from "@/domain/fitment";
import type { FitmentEvidence } from "@/domain/types";

function evidence(overrides: Partial<FitmentEvidence>): FitmentEvidence {
  return {
    id: "fixture-evidence",
    kind: "community_report",
    outcome: "fits_without_modification",
    moderationStatus: "accepted",
    exactModel: true,
    exactDesignRevision: true,
    reporterKey: "fixture-reporter",
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

  it("rejects an unsupported claim with accepted exact incompatibility evidence", () => {
    const result = evaluateFitmentEvidence([
      evidence({ outcome: "does_not_fit", reporterKey: "negative" }),
    ]);
    expect(result.status).toBe("rejected");
  });

  it("keeps OEM mappings as candidates", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "oem_mapping", outcome: undefined, exactDesignRevision: false, reporterKey: undefined }),
    ]);
    expect(result.status).toBe("candidate_match");
  });

  it.each(["oem_mapping", "dimensional_match", "editorial_note"] as const)(
    "gives %s zero confirmation authority",
    (kind) => {
      const result = evaluateFitmentEvidence([
        evidence({ kind, outcome: undefined, exactDesignRevision: false, reporterKey: undefined }),
      ]);
      expect(result.status).toBe("candidate_match");
    },
  );

  it("requires exact model and exact revision for confirmation", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "trusted_physical_test", exactDesignRevision: false }),
      evidence({ kind: "creator_claim", exactModel: false, outcome: undefined }),
    ]);
    expect(result.status).toBe("candidate_match");
  });

  it("does not turn a modified trusted fit into an unqualified verified fit", () => {
    const result = evaluateFitmentEvidence([
      evidence({
        kind: "trusted_physical_test",
        outcome: "fits_after_modification",
        modificationNotes: "Trim fictional tab by 1 mm.",
      }),
    ]);
    expect(result.status).toBe("candidate_match");
  });

  it("deduplicates community confirmations by independent actor", () => {
    const result = evaluateFitmentEvidence([
      evidence({ id: "a", reporterKey: "same", installedPhoto: true }),
      evidence({ id: "b", reporterKey: "same" }),
    ]);
    expect(result.status).toBe("candidate_match");
    expect(result.acceptedPositiveReports).toBe(1);
  });

  it("ignores evidence that moderation has not accepted", () => {
    const result = evaluateFitmentEvidence([
      evidence({ kind: "trusted_physical_test", moderationStatus: "pending" }),
      evidence({ outcome: "does_not_fit", moderationStatus: "rejected" }),
    ]);
    expect(result.status).toBe("candidate_match");
  });

  it("is deterministic and reports its ruleset", () => {
    const fixture = [
      evidence({ id: "b", reporterKey: "actor-b", installedPhoto: true }),
      evidence({ id: "a", reporterKey: "actor-a" }),
    ];
    const first = evaluateFitmentEvidence(fixture);
    expect(evaluateFitmentEvidence(structuredClone(fixture))).toEqual(first);
    expect(first.rulesetVersion).toBe("fitment-v1");
  });

  it("does not allow commercial metadata to affect confidence", () => {
    const fixture = evidence({ kind: "creator_claim", outcome: undefined });
    const sponsoredFixture = { ...fixture, sponsored: true, affiliateValue: 999_999 };
    expect(evaluateFitmentEvidence([sponsoredFixture])).toEqual(evaluateFitmentEvidence([fixture]));
  });
});
