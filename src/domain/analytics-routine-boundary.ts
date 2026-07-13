export interface AnalyticsPublicRoutineBoundary {
  readonly directApplicationGrants: readonly string[];
  readonly directPgTrgmGrants: readonly string[];
  readonly effectiveApplicationRoutines: readonly string[];
  readonly effectivePgTrgmRoutines: readonly string[];
  readonly nonCallableTriggerRoutines: readonly string[];
}

export interface AnalyticsPublicRoutineBoundaryAssessment {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export const ANALYTICS_RECORDER_SIGNATURE =
  "public.record_private_analytics_event(text, jsonb)";

export const APPROVED_NON_CALLABLE_TRIGGER_ROUTINES = Object.freeze([
  "public.reject_audit_log_mutation()",
] as const);

function exactList(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function assessAnalyticsPublicRoutineBoundary(
  boundary: AnalyticsPublicRoutineBoundary,
  approvedPgTrgmSignatures: readonly string[],
): AnalyticsPublicRoutineBoundaryAssessment {
  const violations: string[] = [];
  if (!exactList(boundary.directApplicationGrants, [ANALYTICS_RECORDER_SIGNATURE])) {
    violations.push("ANALYTICS_DIRECT_APPLICATION_ROUTINE_GRANTS_INVALID");
  }
  if (boundary.directPgTrgmGrants.length !== 0) {
    violations.push("ANALYTICS_DIRECT_PG_TRGM_GRANT");
  }
  if (!exactList(boundary.effectiveApplicationRoutines, [ANALYTICS_RECORDER_SIGNATURE])) {
    const unexpected = boundary.effectiveApplicationRoutines.find(
      (identity) => identity !== ANALYTICS_RECORDER_SIGNATURE,
    );
    violations.push(unexpected
      ? `ANALYTICS_UNEXPECTED_APPLICATION_ROUTINE:${unexpected}`
      : "ANALYTICS_APPLICATION_RECORDER_EXECUTE_MISSING");
  }
  if (!exactList(boundary.effectivePgTrgmRoutines, approvedPgTrgmSignatures)) {
    violations.push("ANALYTICS_PG_TRGM_EFFECTIVE_SET_INVALID");
  }
  if (!exactList(boundary.nonCallableTriggerRoutines, APPROVED_NON_CALLABLE_TRIGGER_ROUTINES)) {
    violations.push("ANALYTICS_NON_CALLABLE_TRIGGER_BASELINE_INVALID");
  }
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
