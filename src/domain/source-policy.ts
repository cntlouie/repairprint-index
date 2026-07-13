export const SOURCE_POLICY_FRESHNESS_DAYS = 366;

export type SourcePolicyFailureCode =
  | "SOURCE_POLICY_MISSING"
  | "SOURCE_POLICY_BLOCKED"
  | "SOURCE_POLICY_DISABLED"
  | "SOURCE_AUTOMATION_FORBIDDEN"
  | "SOURCE_COMMERCIAL_USE_INCOMPATIBLE"
  | "SOURCE_POLICY_STALE"
  | "SOURCE_POLICY_SNAPSHOT_MISMATCH"
  | "SOURCE_FIELD_NOT_ALLOWED";

export interface SourcePolicySnapshot {
  readonly platform: string;
  readonly policy: "api" | "creator_submission" | "written_permission" | "link_only" | "blocked";
  readonly policyVersion: string;
  readonly termsCheckedAt: Date;
  readonly expiresAt: Date;
  readonly allowedFields: readonly string[];
  readonly automationAllowed: boolean;
  readonly commercialUseAllowed: boolean | null;
  readonly adapterEnabled: boolean;
  readonly currentPolicyMatches: boolean;
}

export type SourcePolicyDecision =
  | { readonly allowed: true; readonly policyVersion: string; readonly allowedFields: readonly string[] }
  | { readonly allowed: false; readonly code: SourcePolicyFailureCode };

export function evaluateSourceAdapterPolicy(
  snapshot: SourcePolicySnapshot | null,
  requestedFields: readonly string[],
  now: Date,
): SourcePolicyDecision {
  if (!snapshot) return { allowed: false, code: "SOURCE_POLICY_MISSING" };
  if (snapshot.policy === "blocked") return { allowed: false, code: "SOURCE_POLICY_BLOCKED" };
  if (!snapshot.currentPolicyMatches) return { allowed: false, code: "SOURCE_POLICY_SNAPSHOT_MISMATCH" };
  if (!snapshot.adapterEnabled) return { allowed: false, code: "SOURCE_POLICY_DISABLED" };
  if (!snapshot.automationAllowed) return { allowed: false, code: "SOURCE_AUTOMATION_FORBIDDEN" };
  if (snapshot.commercialUseAllowed !== true) {
    return { allowed: false, code: "SOURCE_COMMERCIAL_USE_INCOMPATIBLE" };
  }

  const maximumFreshUntil = new Date(
    snapshot.termsCheckedAt.getTime() + SOURCE_POLICY_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
  );
  if (now > snapshot.expiresAt || now > maximumFreshUntil) {
    return { allowed: false, code: "SOURCE_POLICY_STALE" };
  }

  const allowed = new Set(snapshot.allowedFields);
  if (requestedFields.some((field) => !allowed.has(field))) {
    return { allowed: false, code: "SOURCE_FIELD_NOT_ALLOWED" };
  }

  return {
    allowed: true,
    policyVersion: snapshot.policyVersion,
    allowedFields: Object.freeze([...snapshot.allowedFields]),
  };
}

export function selectAllowedSourceFields(
  record: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(record, field)) result[field] = record[field];
  }
  return Object.freeze(result);
}
