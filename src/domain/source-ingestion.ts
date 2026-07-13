import { createHash } from "node:crypto";

export const SOURCE_INGESTION_TRANSITIONS = Object.freeze({
  discovered: Object.freeze(["fetched", "rejected"]),
  fetched: Object.freeze(["parsed", "rejected"]),
  parsed: Object.freeze(["normalized", "rejected"]),
  normalized: Object.freeze(["ambiguous", "safety_screened", "rejected"]),
  ambiguous: Object.freeze(["review_ready", "rejected"]),
  safety_screened: Object.freeze(["review_ready", "rejected"]),
  review_ready: Object.freeze(["approved", "rejected"]),
  approved: Object.freeze([]),
  rejected: Object.freeze([]),
} as const);

export type SourceIngestionStage = keyof typeof SOURCE_INGESTION_TRANSITIONS;

export function canTransitionSourceIngestion(from: SourceIngestionStage, to: SourceIngestionStage): boolean {
  return (SOURCE_INGESTION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sourceContentChecksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sourceRunFingerprint(input: {
  readonly platform: string;
  readonly externalId: string;
  readonly contentChecksum: string;
  readonly adapterVersion: string;
  readonly policyVersion: string;
}): string {
  return createHash("sha256")
    .update([input.platform, input.externalId, input.contentChecksum, input.adapterVersion, input.policyVersion].join("\0"))
    .digest("hex");
}
