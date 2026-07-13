export const SOURCE_POLICY_FRESHNESS_DAYS = 366;
export const SOURCE_SAFE_METADATA_FIELDS = Object.freeze([
  "external_id",
  "landing_page_url",
  "title",
  "creator",
  "creator_name",
  "license",
  "license_state",
  "source_revision",
  "claimed_compatibility",
  "model",
  "component",
  "print_settings",
] as const);

const safeMetadataFields = new Set<string>(SOURCE_SAFE_METADATA_FIELDS);

export type SourcePolicyFailureCode =
  | "SOURCE_POLICY_MISSING"
  | "SOURCE_POLICY_BLOCKED"
  | "SOURCE_POLICY_DISABLED"
  | "SOURCE_AUTOMATION_FORBIDDEN"
  | "SOURCE_COMMERCIAL_USE_INCOMPATIBLE"
  | "SOURCE_POLICY_STALE"
  | "SOURCE_POLICY_SNAPSHOT_MISMATCH"
  | "SOURCE_POLICY_PLATFORM_MISMATCH"
  | "SOURCE_POLICY_REVIEW_MISMATCH"
  | "SOURCE_FIELD_NOT_ALLOWED";

export interface SourcePolicySnapshot {
  readonly reviewId: string;
  readonly platform: string;
  readonly policy: "api" | "creator_submission" | "written_permission" | "link_only" | "blocked";
  readonly policyVersion: string;
  readonly permissionScope: string | null;
  readonly termsUrl: string;
  readonly termsChecksum: string;
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
  request: Readonly<{
    platform: string;
    policyReviewId: string;
    requestedFields: readonly string[];
  }>,
  now: Date,
): SourcePolicyDecision {
  if (!snapshot) return { allowed: false, code: "SOURCE_POLICY_MISSING" };
  if (snapshot.platform !== request.platform) return { allowed: false, code: "SOURCE_POLICY_PLATFORM_MISMATCH" };
  if (snapshot.reviewId !== request.policyReviewId) return { allowed: false, code: "SOURCE_POLICY_REVIEW_MISMATCH" };
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
  if (!areSafeSourceMetadataFields(snapshot.allowedFields)
    || !areSafeSourceMetadataFields(request.requestedFields)
    || request.requestedFields.some((field) => !allowed.has(field))) {
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
  if (!areSafeSourceMetadataFields(allowedFields)) throw new Error("SOURCE_POLICY_FIELD_FORBIDDEN");
  const result: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(record, field)) {
      const value = record[field];
      if (!isSafeSourceMetadataValue(value)) throw new Error("SOURCE_POLICY_FIELD_FORBIDDEN");
      result[field] = value;
    }
  }
  return Object.freeze(result);
}

export function areSafeSourceMetadataFields(fields: readonly string[]): boolean {
  return fields.length > 0
    && new Set(fields).size === fields.length
    && fields.every((field) => safeMetadataFields.has(field));
}

export function isSafeSourceMetadataPayload(payload: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(payload).every(([field, value]) =>
    safeMetadataFields.has(field) && isSafeSourceMetadataValue(value));
}

function isSafeSourceMetadataValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.every((child) =>
    child === null || typeof child === "string" || typeof child === "boolean"
      || (typeof child === "number" && Number.isFinite(child)));
}
