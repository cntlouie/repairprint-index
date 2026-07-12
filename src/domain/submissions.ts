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

/** Semantic queue-deduplication key. Display payload and independent contributors remain separate. */
export function canonicalSubmissionDedupeContent(
  kind: AnonymousSubmissionKind,
  payload: Record<string, unknown>,
): string {
  switch (kind) {
    case "missing_part":
      return stableJson({
        brand: strictText(payload.brand),
        brokenPart: semanticText(payload.brokenPart),
        modelNumber: strictText(payload.modelNumber),
        oemPartNumber: strictText(payload.oemPartNumber),
      });
    case "fit_confirmation":
      return stableJson({
        designRevision: strictText(payload.designRevision),
        evidenceUrl: canonicalStoredUrl(payload.evidenceUrl),
        modelNumber: strictText(payload.modelNumber),
        modificationNotes: semanticText(payload.modificationNotes),
        outcome: payload.outcome,
        partSlug: strictText(payload.partSlug),
        printSettings: semanticText(payload.printSettings),
      });
    case "design_submission":
      return stableJson({
        brand: strictText(payload.brand),
        claimedLicense: strictText(payload.claimedLicense),
        componentName: semanticText(payload.componentName),
        creatorName: semanticText(payload.creatorName),
        modelNumber: strictText(payload.modelNumber),
        sourceUrl: canonicalStoredUrl(payload.sourceUrl),
      });
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
