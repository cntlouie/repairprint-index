const allowedSourceErrorCodes = Object.freeze([
  "SOURCE_ACTOR_UNAUTHORIZED",
  "SOURCE_AUTOMATION_FORBIDDEN",
  "SOURCE_CANDIDATE_IDENTITY_INVALID",
  "SOURCE_CANDIDATE_PAYLOAD_INVALID",
  "SOURCE_CANDIDATE_STAGE_CONFLICT",
  "SOURCE_CANDIDATE_TRANSITION_INVALID",
  "SOURCE_FIELD_NOT_ALLOWED",
  "SOURCE_POLICY_BLOCKED",
  "SOURCE_POLICY_BLOCKED_CONFIGURATION_INVALID",
  "SOURCE_POLICY_FIELD_FORBIDDEN",
  "SOURCE_POLICY_MISSING",
  "SOURCE_POLICY_REVIEW_INVALID",
  "SOURCE_POLICY_REVIEWER_REQUIRED",
  "SOURCE_POLICY_SNAPSHOT_MISMATCH",
  "SOURCE_POLICY_STALE",
  "SOURCE_POLICY_VERSION_CONFLICT",
  "SOURCE_REQUEST_ID_REQUIRED",
  "SOURCE_REVIEWER_REQUIRED",
  "SOURCE_RUN_IDENTITY_INVALID",
  "SOURCE_TRANSITION_ATTRIBUTION_REQUIRED",
] as const);

export function sanitizeSourceOperationError(error: unknown): Error {
  if (error instanceof Error && error.name === "ZodError") return error;
  if (error instanceof Error && "code" in error
    && ["AUTH_REQUIRED", "TOKEN_INVALID", "STAFF_NOT_FOUND", "STAFF_INACTIVE", "MFA_REQUIRED", "FORBIDDEN"].includes(String(error.code))) {
    return error;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : "";
    const code = allowedSourceErrorCodes.find((candidate) => message.includes(candidate));
    if (code) return new Error(code);
    current = current && typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return new Error("SOURCE_OPERATION_UNAVAILABLE");
}
