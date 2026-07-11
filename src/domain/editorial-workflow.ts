import type { StaffRole } from "./authorization";

export const EDITORIAL_PUBLICATION_STATES = [
  "draft",
  "in_review",
  "published",
  "needs_review",
  "archived",
] as const;
export type EditorialPublicationState = (typeof EDITORIAL_PUBLICATION_STATES)[number];

export const EDITORIAL_SUBMISSION_STATES = [
  "pending",
  "in_review",
  "accepted",
  "rejected",
  "resolved",
] as const;
export type EditorialSubmissionState = (typeof EDITORIAL_SUBMISSION_STATES)[number];

export type EditorialTransitionDecision =
  | { allowed: true }
  | { allowed: false; code: "TRANSITION_INVALID" | "ROLE_INSUFFICIENT" | "SELF_REVIEW_FORBIDDEN" };

const PUBLICATION_TRANSITIONS: Readonly<Record<EditorialPublicationState, ReadonlySet<EditorialPublicationState>>> = {
  draft: new Set(["in_review", "archived"]),
  in_review: new Set(["published", "archived"]),
  published: new Set(["needs_review", "archived"]),
  needs_review: new Set(["published", "archived"]),
  archived: new Set(),
};

const SUBMISSION_TRANSITIONS: Readonly<Record<EditorialSubmissionState, ReadonlySet<EditorialSubmissionState>>> = {
  pending: new Set(["in_review", "rejected"]),
  in_review: new Set(["accepted", "rejected"]),
  accepted: new Set(["resolved", "in_review"]),
  rejected: new Set(["in_review"]),
  resolved: new Set(["in_review"]),
};

export function evaluatePublicationTransition(
  from: EditorialPublicationState,
  to: EditorialPublicationState,
  role: StaffRole,
): EditorialTransitionDecision {
  if (!PUBLICATION_TRANSITIONS[from].has(to)) return { allowed: false, code: "TRANSITION_INVALID" };
  if (to === "archived" && role !== "admin") return { allowed: false, code: "ROLE_INSUFFICIENT" };
  if ((to === "published" || from === "published") && role === "editor") {
    return { allowed: false, code: "ROLE_INSUFFICIENT" };
  }
  return { allowed: true };
}

export function evaluateSubmissionTransition(
  from: EditorialSubmissionState,
  to: EditorialSubmissionState,
  role: StaffRole,
): EditorialTransitionDecision {
  if (!SUBMISSION_TRANSITIONS[from].has(to)) return { allowed: false, code: "TRANSITION_INVALID" };
  if ((to === "accepted" || to === "rejected" || to === "resolved") && role === "editor") {
    return { allowed: false, code: "ROLE_INSUFFICIENT" };
  }
  return { allowed: true };
}

export function evaluateIndependentReview(preparedBy: string, reviewedBy: string): EditorialTransitionDecision {
  return preparedBy === reviewedBy
    ? { allowed: false, code: "SELF_REVIEW_FORBIDDEN" }
    : { allowed: true };
}

export function validateArchiveRedirect(oldPath: string, replacementPath: string): boolean {
  return (
    oldPath.startsWith("/") &&
    replacementPath.startsWith("/") &&
    oldPath !== replacementPath &&
    !replacementPath.startsWith("//") &&
    !replacementPath.includes("://")
  );
}
