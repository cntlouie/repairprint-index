import type { FitmentDecision, FitmentEvidence } from "./types";

const POSITIVE_OUTCOMES = new Set([
  "fits_without_modification",
  "fits_after_modification",
]);

/**
 * Evaluates evidence for one exact design revision × exact product model edge.
 * Safety is deliberately evaluated elsewhere: a design can fit and still be unsafe.
 */
export function evaluateFitmentEvidence(evidence: FitmentEvidence[]): FitmentDecision {
  const accepted = evidence.filter((item) => item.moderationStatus === "accepted");

  const credibleNegatives = accepted.filter(
    (item) =>
      item.outcome === "does_not_fit" &&
      item.exactModel &&
      item.exactDesignRevision,
  );

  const trustedExactTests = accepted.filter(
    (item) =>
      item.kind === "trusted_physical_test" &&
      item.exactModel &&
      item.exactDesignRevision &&
      item.outcome === "fits_without_modification",
  );

  const exactCommunityPositives = accepted.filter(
    (item) =>
      item.kind === "community_report" &&
      item.exactModel &&
      item.exactDesignRevision &&
      item.outcome !== undefined &&
      POSITIVE_OUTCOMES.has(item.outcome) &&
      Boolean(item.reporterKey),
  );

  const distinctPositiveReporters = new Set(
    exactCommunityPositives.map((item) => item.reporterKey),
  );
  const hasInstalledPhoto = exactCommunityPositives.some((item) => item.installedPhoto);

  const creatorExactClaim = accepted.some(
    (item) => item.kind === "creator_claim" && item.exactModel && item.exactDesignRevision,
  );
  const oemMapping = accepted.some((item) => item.kind === "oem_mapping");
  const dimensionalMatch = accepted.some((item) => item.kind === "dimensional_match");

  if (credibleNegatives.length > 0) {
    return {
      status: "disputed",
      score: 0,
      reasons: ["Accepted exact-model incompatibility evidence requires review."],
      acceptedPositiveReports: distinctPositiveReporters.size,
      acceptedNegativeReports: credibleNegatives.length,
    };
  }

  if (trustedExactTests.length > 0) {
    return {
      status: "verified_fit",
      score: 100,
      reasons: ["A trusted reviewer physically tested this exact design revision on this exact model."],
      acceptedPositiveReports: distinctPositiveReporters.size,
      acceptedNegativeReports: 0,
    };
  }

  if (distinctPositiveReporters.size >= 2 && hasInstalledPhoto) {
    return {
      status: "community_confirmed",
      score: 80,
      reasons: ["At least two independent exact-model reports were accepted, including installed-part photo evidence."],
      acceptedPositiveReports: distinctPositiveReporters.size,
      acceptedNegativeReports: 0,
    };
  }

  if (creatorExactClaim) {
    return {
      status: "creator_listed",
      score: 55,
      reasons: ["The original designer explicitly lists this exact model."],
      acceptedPositiveReports: distinctPositiveReporters.size,
      acceptedNegativeReports: 0,
    };
  }

  const candidateReasons = [
    oemMapping ? "An OEM component mapping suggests compatibility, but no printed fit is confirmed." : undefined,
    dimensionalMatch ? "Dimensions suggest compatibility, but no printed fit is confirmed." : undefined,
    "Candidate matches are never presented as confirmed fits.",
  ].filter((reason): reason is string => Boolean(reason));

  return {
    status: "candidate_match",
    score: oemMapping && dimensionalMatch ? 35 : oemMapping || dimensionalMatch ? 25 : 10,
    reasons: candidateReasons,
    acceptedPositiveReports: distinctPositiveReporters.size,
    acceptedNegativeReports: 0,
  };
}
