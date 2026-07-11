import type { PublishabilityDecision, PublishabilityInput } from "./types";

export function evaluatePublishability(input: PublishabilityInput): PublishabilityDecision {
  const blockers: string[] = [];

  if (input.safetyClass !== "low") blockers.push("MVP publishes low-risk records only.");
  if (!input.sourceIsLive) blockers.push("Original source link is not live.");
  if (!input.creatorRecorded) blockers.push("Creator attribution is missing.");
  if (!input.licenseRecorded) blockers.push("Licence status is missing; use NOT-STATED when necessary.");
  if (!input.exactTargetRecorded) blockers.push("No exact product/component target is recorded.");
  if (!input.safetyReviewed) blockers.push("Safety review is incomplete.");
  if (!input.sourceRetrievedAt) blockers.push("Source retrieval date is missing.");
  if (!input.sourceLastCheckedAt) blockers.push("Source last-checked date is missing.");
  if (input.fitmentStatus === "disputed") blockers.push("Fitment has an unresolved dispute.");

  const publish = blockers.length === 0;
  const index =
    publish &&
    input.fitmentStatus !== "candidate_match" &&
    input.fitmentStatus !== "disputed";

  return { publish, index, blockers };
}
