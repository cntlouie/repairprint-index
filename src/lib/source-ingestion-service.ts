import "server-only";

import { sourceRunFingerprint } from "@/domain/source-ingestion";
import { evaluateSourceAdapterPolicy, type SourcePolicySnapshot } from "@/domain/source-policy";
import type { PrivateSourceCandidateResult } from "@/db/source-operations";
import type { SourceAdapter } from "@/lib/source-adapters";

export class SourceIngestionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SourceIngestionError";
  }
}

export async function ingestAdapterCandidate(input: {
  readonly adapter: SourceAdapter;
  readonly externalId: string;
  readonly policy: SourcePolicySnapshot | null;
  readonly now: Date;
  readonly actorId: string;
  readonly requestId: string;
  readonly policyReviewId: string;
  readonly persist: (input: {
    readonly platform: string;
    readonly externalId: string;
    readonly contentChecksum: string;
    readonly allowedPayload: Readonly<Record<string, unknown>>;
    readonly adapterVersion: string;
    readonly policyReviewId: string;
    readonly retrievedAt: Date;
    readonly actorId: string;
    readonly requestId: string;
    readonly runPublicId: string;
    readonly runFingerprint: string;
  }) => Promise<PrivateSourceCandidateResult>;
}): Promise<PrivateSourceCandidateResult> {
  const decision = evaluateSourceAdapterPolicy(input.policy, input.adapter.requestedFields, input.now);
  if (!decision.allowed) throw new SourceIngestionError(decision.code);

  const record = await input.adapter.fetchCandidate(input.externalId);
  const runFingerprint = sourceRunFingerprint({
    platform: input.adapter.platform,
    externalId: input.externalId,
    contentChecksum: record.contentChecksum,
    adapterVersion: input.adapter.version,
    policyVersion: decision.policyVersion,
  });
  return input.persist({
    platform: input.adapter.platform,
    externalId: input.externalId,
    contentChecksum: record.contentChecksum,
    allowedPayload: record.payload,
    adapterVersion: input.adapter.version,
    policyReviewId: input.policyReviewId,
    retrievedAt: record.retrievedAt,
    actorId: input.actorId,
    requestId: input.requestId,
    runPublicId: `src_${runFingerprint.slice(0, 24)}`,
    runFingerprint,
  });
}
