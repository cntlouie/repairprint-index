import type { PublishabilityDecision, PublishabilityInput } from "./types";
import { CURRENT_FITMENT_RULESET, CURRENT_SAFETY_RULESET } from "./rulesets";

export function evaluatePublishability(input: PublishabilityInput): PublishabilityDecision {
  const blockers: string[] = [];
  const errorCodes: PublishabilityDecision["errorCodes"] = [];

  const block = (code: PublishabilityDecision["errorCodes"][number], message: string) => {
    errorCodes.push(code);
    blockers.push(message);
  };

  if (input.sourcePolicy === "blocked" || input.sourcePolicy === "stale") {
    block("SRC-001", "Source policy is blocked or stale.");
  }
  if (input.sourcePolicy === "permission_missing") {
    block("SRC-002", "The required API permission or acquisition authority is missing.");
  }
  if (!input.originalLandingPageAvailable) block("LINK-001", "Original source link is unavailable.");
  if (!input.creatorRecorded || !input.attributionComplete) {
    block("RIGHTS-004", "Creator attribution is incomplete.");
  }
  if (!input.licenseRecorded) {
    block("RIGHTS-001", "Licence status is missing; use NOT-STATED when necessary.");
  }
  if (!input.exactTargetRecorded) block("FIT-001", "No exact product/component target is recorded.");
  if (!input.claimProvenanceComplete) block("PROV-001", "Claim provenance is incomplete.");
  if (!input.safetyReviewed) block("SAFE-002", "Safety review is incomplete.");
  if (input.safetyClass !== "low") block("SAFE-001", "V0 publishes low-risk records only.");
  if (input.openRightsOrSafetyNotice) {
    block("UGC-003", "An open takedown, rights, or safety notice places this record on hold.");
  }
  if (!input.sourceRetrievedAt) block("PROV-001", "Source retrieval date is missing.");
  if (!input.sourceLastCheckedAt) block("PROV-001", "Source last-checked date is missing.");
  if (input.fitmentStatus === "disputed") block("FIT-003", "Fitment has an unresolved dispute.");
  if (input.fitmentStatus === "rejected") block("FIT-002", "Fitment was rejected.");
  if (input.fitmentRulesetVersion !== CURRENT_FITMENT_RULESET) {
    block("FIT-004", "Fitment confidence was computed with a stale ruleset.");
  }
  if (input.safetyRulesetVersion !== CURRENT_SAFETY_RULESET) {
    block("SAFE-004", "Safety was computed with a stale ruleset.");
  }
  if (!input.designRevisionIdentified || !input.designRevisionCurrent) {
    block("FIT-005", "The current design revision is not identified.");
  }

  const publish = blockers.length === 0;
  const index =
    publish &&
    input.fitmentStatus !== "candidate_match" &&
    input.fitmentStatus !== "disputed" &&
    input.fitmentStatus !== "rejected";

  return { publish, index, blockers, errorCodes };
}
