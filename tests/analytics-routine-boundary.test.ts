import { describe, expect, it } from "vitest";

import {
  ANALYTICS_RECORDER_SIGNATURE,
  APPROVED_NON_CALLABLE_TRIGGER_ROUTINES,
  assessAnalyticsPublicRoutineBoundary,
  type AnalyticsPublicRoutineBoundary,
} from "@/domain/analytics-routine-boundary";

const pgTrgmSignatures = [
  "public.similarity(text, text)",
  "public.word_similarity(text, text)",
] as const;

const approvedBoundary: AnalyticsPublicRoutineBoundary = {
  directApplicationGrants: [ANALYTICS_RECORDER_SIGNATURE],
  directPgTrgmGrants: [],
  effectiveApplicationRoutines: [ANALYTICS_RECORDER_SIGNATURE],
  effectivePgTrgmRoutines: pgTrgmSignatures,
  nonCallableTriggerRoutines: APPROVED_NON_CALLABLE_TRIGGER_ROUTINES,
};

describe("analytics public routine boundary", () => {
  it("accepts only the recorder plus the exact inherited pg_trgm baseline", () => {
    expect(assessAnalyticsPublicRoutineBoundary(approvedBoundary, pgTrgmSignatures)).toEqual({
      valid: true,
      violations: [],
    });
  });

  it.each([
    ["missing recorder grant", { directApplicationGrants: [] }],
    ["extra application grant", { directApplicationGrants: [ANALYTICS_RECORDER_SIGNATURE, "public.extra()"] }],
    ["direct pg_trgm grant", { directPgTrgmGrants: [pgTrgmSignatures[0]] }],
    ["missing effective recorder", { effectiveApplicationRoutines: [] }],
    ["unexpected effective application routine", { effectiveApplicationRoutines: [ANALYTICS_RECORDER_SIGNATURE, "public.extra()"] }],
    ["altered effective pg_trgm set", { effectivePgTrgmRoutines: [pgTrgmSignatures[0]] }],
    ["altered trigger baseline", { nonCallableTriggerRoutines: [] }],
  ] satisfies readonly [string, Partial<AnalyticsPublicRoutineBoundary>][]) (
    "fails closed for %s",
    (_label, update) => {
      expect(assessAnalyticsPublicRoutineBoundary(
        { ...approvedBoundary, ...update },
        pgTrgmSignatures,
      ).valid).toBe(false);
    },
  );

  it("reports the sanitized identity of an unrelated effective application routine", () => {
    const assessment = assessAnalyticsPublicRoutineBoundary({
      ...approvedBoundary,
      effectiveApplicationRoutines: [ANALYTICS_RECORDER_SIGNATURE, "public.unrelated(integer)"],
    }, pgTrgmSignatures);
    expect(assessment.violations).toContain(
      "ANALYTICS_UNEXPECTED_APPLICATION_ROUTINE:public.unrelated(integer)",
    );
  });
});
