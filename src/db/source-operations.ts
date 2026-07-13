import "server-only";

import type postgres from "postgres";

import { getSourceDatabaseClient } from "@/db/source-client";
import type { SourceIngestionStage } from "@/domain/source-ingestion";
import { sanitizeSourceOperationError } from "@/lib/source-errors";

export interface PrivateSourceCandidateInput {
  readonly platform: string;
  readonly externalId: string;
  readonly origin: "adapter" | "manual" | "creator_submission";
  readonly contentChecksum: string;
  readonly allowedPayload: postgres.JSONValue;
  readonly adapterVersion: string;
  readonly policyReviewId: string;
  readonly retrievedAt: Date;
  readonly actorId: string;
  readonly requestId: string;
  readonly runPublicId?: string;
  readonly runFingerprint?: string;
}

export interface PrivateSourceCandidateResult {
  readonly runId: string | null;
  readonly candidateId: string;
  readonly versionId: string;
  readonly runCreated: boolean;
  readonly candidateCreated: boolean;
  readonly versionCreated: boolean;
}

export async function upsertPrivateSourceCandidate(
  input: PrivateSourceCandidateInput,
): Promise<PrivateSourceCandidateResult> {
  try {
    const sql = await getSourceDatabaseClient();
    const [result] = await sql<PrivateSourceCandidateResult[]>`
    SELECT
      run_id AS "runId",
      candidate_id AS "candidateId",
      version_id AS "versionId",
      run_created AS "runCreated",
      candidate_created AS "candidateCreated",
      version_created AS "versionCreated"
    FROM public.upsert_private_source_candidate(
      ${input.platform}, ${input.externalId}, ${input.origin}, ${input.contentChecksum},
      ${sql.json(input.allowedPayload)}, ${input.adapterVersion}, ${input.policyReviewId},
      ${input.retrievedAt}, ${input.actorId}, ${input.requestId},
      ${input.runPublicId ?? null}, ${input.runFingerprint ?? null}
    )
    `;
    if (!result) throw new Error("SOURCE_CANDIDATE_UPSERT_FAILED");
    return Object.freeze(result);
  } catch (error) {
    throw sanitizeSourceOperationError(error);
  }
}

export async function transitionPrivateSourceCandidate(input: {
  readonly versionId: string;
  readonly expectedStage: SourceIngestionStage;
  readonly nextStage: SourceIngestionStage;
  readonly actorId: string;
  readonly reason: string;
  readonly requestId: string;
}): Promise<void> {
  try {
    const sql = await getSourceDatabaseClient();
    await sql`
      SELECT public.transition_source_candidate_version(
        ${input.versionId}, ${input.expectedStage}, ${input.nextStage},
        ${input.actorId}, ${input.reason}, ${input.requestId}
      )
    `;
  } catch (error) {
    throw sanitizeSourceOperationError(error);
  }
}
