import { describe, expect, it } from "vitest";

import {
  evaluateIndependentReview,
  evaluatePublicationTransition,
  evaluateSubmissionTransition,
  validateArchiveRedirect,
} from "@/domain/editorial-workflow";

describe("editorial workflow", () => {
  it.each([
    ["draft", "in_review", "editor", true],
    ["in_review", "published", "reviewer", true],
    ["in_review", "published", "editor", false],
    ["published", "needs_review", "reviewer", true],
    ["published", "archived", "reviewer", false],
    ["published", "archived", "admin", true],
    ["archived", "published", "admin", false],
  ] as const)("evaluates %s -> %s for %s", (from, to, role, allowed) => {
    expect(evaluatePublicationTransition(from, to, role).allowed).toBe(allowed);
  });

  it.each([
    ["pending", "in_review", "editor", true],
    ["in_review", "accepted", "editor", false],
    ["in_review", "accepted", "reviewer", true],
    ["in_review", "rejected", "reviewer", true],
    ["accepted", "resolved", "reviewer", true],
    ["pending", "resolved", "admin", false],
  ] as const)("evaluates submission %s -> %s for %s", (from, to, role, allowed) => {
    expect(evaluateSubmissionTransition(from, to, role).allowed).toBe(allowed);
  });

  it("prevents editors from reviewing their own prepared case", () => {
    expect(evaluateIndependentReview("staff-a", "staff-a")).toEqual({
      allowed: false,
      code: "SELF_REVIEW_FORBIDDEN",
    });
    expect(evaluateIndependentReview("staff-a", "staff-b")).toEqual({ allowed: true });
  });

  it.each([
    ["/parts/old", "/parts/replacement", true],
    ["/parts/old", "/parts/old", false],
    ["/parts/old", "https://example.invalid", false],
    ["parts/old", "/", false],
  ] as const)("validates archive redirect %s -> %s", (oldPath, replacementPath, valid) => {
    expect(validateArchiveRedirect(oldPath, replacementPath)).toBe(valid);
  });
});
