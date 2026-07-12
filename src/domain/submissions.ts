import { strictIdentifierKey } from "./normalization";

export type AnonymousSubmissionKind = "missing_part" | "fit_confirmation" | "design_submission";

const intakeControlFields = new Set([
  "challengeToken",
  "contributionConsent",
  "email",
  "emailFollowUpConsent",
  "idempotencyKey",
  "privacyConsent",
  "website",
]);

export function privateSubmissionPayload(intake: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(intake).filter(([field]) => !intakeControlFields.has(field)),
  );
}

export function canonicalSubmissionContent(
  kind: AnonymousSubmissionKind,
  payload: Record<string, unknown>,
): string {
  return stableJson({ kind, payload });
}

export type AnonymousSubmissionRequestFingerprint = Readonly<{
  contact: Readonly<{
    digest: string | null;
    present: boolean;
  }>;
  decisions: Readonly<{
    contributionConsent: boolean;
    emailFollowUpConsent: boolean;
    privacyConsent: boolean;
  }>;
  kind: AnonymousSubmissionKind;
  payload: Record<string, unknown>;
  versions: Readonly<{
    contactConsent: string;
    contributorTerms: string;
    privacyNotice: string;
    retentionPolicy: string;
  }>;
}>;

/**
 * Stable, private idempotency comparison material.
 *
 * The caller supplies only the canonical persisted payload and a keyed contact
 * digest. Network identity, challenge tokens, timestamps, expiry deadlines,
 * receipt identifiers and other per-attempt values deliberately have no place
 * in this representation.
 */
export function canonicalSubmissionRequestFingerprint(
  input: AnonymousSubmissionRequestFingerprint,
): string {
  return stableJson({
    contact: {
      digest: input.contact.digest,
      present: input.contact.present,
    },
    decisions: {
      contributionConsent: input.decisions.contributionConsent,
      emailFollowUpConsent: input.decisions.emailFollowUpConsent,
      privacyConsent: input.decisions.privacyConsent,
    },
    kind: input.kind,
    payload: input.payload,
    versions: {
      contactConsent: input.versions.contactConsent,
      contributorTerms: input.versions.contributorTerms,
      privacyNotice: input.versions.privacyNotice,
      retentionPolicy: input.versions.retentionPolicy,
    },
  });
}

/** Semantic queue-deduplication key. Display payload and independent contributors remain separate. */
export function canonicalSubmissionDedupeContent(
  kind: AnonymousSubmissionKind,
  payload: Record<string, unknown>,
): string {
  return stableJson(semanticSubmissionPayload(kind, payload));
}

/**
 * Canonical moderation/demand projection shared by every equivalent intake.
 *
 * Private wording, notes, print settings and evidence metadata remain on the
 * immutable intake that supplied them. They must never be retained merely
 * because that intake happened to create the semantic parent first.
 */
export function semanticSubmissionPayload(
  kind: AnonymousSubmissionKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case "missing_part":
      return {
        brand: strictText(payload.brand),
        brokenPart: semanticText(payload.brokenPart),
        modelNumber: strictText(payload.modelNumber),
        oemPartNumber: strictText(payload.oemPartNumber),
      };
    case "fit_confirmation":
      return {
        designRevision: strictText(payload.designRevision),
        modelNumber: strictText(payload.modelNumber),
        outcome: payload.outcome,
        partSlug: strictText(payload.partSlug),
      };
    case "design_submission":
      return {
        brand: strictText(payload.brand),
        claimedLicense: strictText(payload.claimedLicense),
        componentName: semanticText(payload.componentName),
        creatorName: semanticText(payload.creatorName),
        modelNumber: strictText(payload.modelNumber),
        sourceUrl: canonicalStoredUrl(payload.sourceUrl),
      };
  }
}

function semanticText(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .normalize("NFKC")
    .toLocaleUpperCase("en")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function strictText(value: unknown): string {
  return strictIdentifierKey(typeof value === "string" ? value : "");
}

function canonicalStoredUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
