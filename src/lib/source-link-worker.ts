import "server-only";

import { randomUUID } from "node:crypto";

import { getSourceDatabaseClient } from "@/db/source-client";
import { getCatalogInvalidationContext } from "@/lib/catalog";
import { attemptCatalogueCacheInvalidation, catalogTagsForContext } from "@/lib/catalog-cache";
import { checkSourceLink } from "@/lib/safe-source-network";
import type { SourceLinkObservation } from "@/domain/source-link-health";

export interface ClaimedSourceLinkJob {
  readonly jobId: string;
  readonly sourceId: string;
  readonly leaseToken: string;
  readonly canonicalUrl: string;
  readonly platform: string | null;
}

export interface CompletedSourceLinkJob {
  readonly checkId: string;
  readonly affectedFitmentIds: readonly string[];
  readonly publicationChanged: boolean;
}

export interface SourceLinkWorkerDependencies {
  readonly claim: (workerId: string) => Promise<readonly ClaimedSourceLinkJob[]>;
  readonly check: (job: ClaimedSourceLinkJob) => Promise<SourceLinkObservation>;
  readonly complete: (job: ClaimedSourceLinkJob, actorId: string, observation: SourceLinkObservation) => Promise<CompletedSourceLinkJob>;
  readonly invalidate: (fitmentIds: readonly string[]) => Promise<Readonly<{ affectedTags: readonly string[]; failedTags: readonly string[] }>>;
}

export class SourceLinkBatchError extends Error {
  readonly code: "SOURCE_LINK_BATCH_FAILED" | "SOURCE_LINK_CACHE_INVALIDATION_FAILED";
  readonly mutationCommitted: boolean;
  readonly affectedFitmentIds: readonly string[];
  readonly affectedTags: readonly string[];
  readonly failedTags: readonly string[];

  constructor(input: {
    code: SourceLinkBatchError["code"];
    mutationCommitted: boolean;
    affectedFitmentIds?: readonly string[];
    affectedTags?: readonly string[];
    failedTags?: readonly string[];
  }) {
    super(input.code);
    this.name = "SourceLinkBatchError";
    this.code = input.code;
    this.mutationCommitted = input.mutationCommitted;
    this.affectedFitmentIds = Object.freeze([...(input.affectedFitmentIds ?? [])]);
    this.affectedTags = Object.freeze([...(input.affectedTags ?? [])]);
    this.failedTags = Object.freeze([...(input.failedTags ?? [])]);
    Object.freeze(this);
  }
}

export async function runSourceLinkBatch(
  workerId: string,
  actorId: string,
  dependencies: SourceLinkWorkerDependencies = defaultDependencies,
): Promise<Readonly<{ claimed: number; completed: number; affectedFitmentIds: readonly string[]; affectedTags: readonly string[] }>> {
  const jobs = await dependencies.claim(workerId);
  const settled: PromiseSettledResult<CompletedSourceLinkJob>[] = [];
  for (let offset = 0; offset < jobs.length; offset += 4) {
    settled.push(...await Promise.allSettled(jobs.slice(offset, offset + 4).map(async (job) => {
      const observation = await dependencies.check(job);
      return dependencies.complete(job, actorId, observation);
    })));
  }

  const completed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const affectedFitmentIds = stableUnique(completed.flatMap((result) => result.publicationChanged ? result.affectedFitmentIds : []));
  let invalidation: Readonly<{ affectedTags: readonly string[]; failedTags: readonly string[] }>;
  try {
    invalidation = affectedFitmentIds.length > 0
      ? await dependencies.invalidate(affectedFitmentIds)
      : { affectedTags: Object.freeze([]), failedTags: Object.freeze([]) };
  } catch {
    throw new SourceLinkBatchError({
      code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
      affectedFitmentIds, affectedTags: ["catalogue:all"], failedTags: ["catalogue:all"],
    });
  }

  if (invalidation.failedTags.length > 0) {
    throw new SourceLinkBatchError({
      code: "SOURCE_LINK_CACHE_INVALIDATION_FAILED", mutationCommitted: true,
      affectedFitmentIds, affectedTags: invalidation.affectedTags, failedTags: invalidation.failedTags,
    });
  }
  if (settled.some((result) => result.status === "rejected")) {
    throw new SourceLinkBatchError({
      code: "SOURCE_LINK_BATCH_FAILED", mutationCommitted: completed.length > 0,
      affectedFitmentIds, affectedTags: invalidation.affectedTags,
    });
  }
  return Object.freeze({
    claimed: jobs.length,
    completed: completed.length,
    affectedFitmentIds: Object.freeze(affectedFitmentIds),
    affectedTags: Object.freeze([...invalidation.affectedTags]),
  });
}

const approvedHostsByPlatform: Readonly<Record<string, readonly string[]>> = Object.freeze({
  thingiverse: Object.freeze(["thingiverse.com", "www.thingiverse.com"]),
  printables: Object.freeze(["printables.com", "www.printables.com"]),
  makerworld: Object.freeze(["makerworld.com", "www.makerworld.com"]),
  ifixit: Object.freeze(["ifixit.com", "www.ifixit.com"]),
});

const defaultDependencies: SourceLinkWorkerDependencies = {
  claim: async (workerId) => {
    const sql = await getSourceDatabaseClient();
    return sql<ClaimedSourceLinkJob[]>`
      SELECT job_id AS "jobId", source_id AS "sourceId", lease_token AS "leaseToken",
        canonical_url AS "canonicalUrl", platform
      FROM public.claim_source_link_check_jobs(${workerId}, 8, 120)
    `;
  },
  check: async (job) => {
    const approvedHosts = job.platform ? approvedHostsByPlatform[job.platform] : undefined;
    if (!approvedHosts) return Object.freeze({
      outcome: "transient_network_error", httpStatus: null, finalUrl: null, responseMs: null,
      errorCode: "SOURCE_PLATFORM_NOT_ALLOWLISTED", redirectHops: 0, retryAfterAt: null,
      contentChecksum: null,
    });
    return checkSourceLink(job.canonicalUrl, approvedHosts);
  },
  complete: async (job, actorId, observation) => {
    const sql = await getSourceDatabaseClient();
    const [result] = await sql<{ checkId: string; affectedFitmentIds: string[]; publicationChanged: boolean }[]>`
      SELECT check_id AS "checkId", affected_fitment_ids AS "affectedFitmentIds",
        publication_changed AS "publicationChanged"
      FROM public.complete_source_link_check(
        ${job.jobId}, ${job.leaseToken}, ${actorId}, ${observation.httpStatus}, ${observation.outcome},
        ${observation.finalUrl}, ${observation.responseMs}, ${observation.errorCode}, ${observation.redirectHops},
        ${observation.retryAfterAt}, ${observation.contentChecksum}, ${`req_source_link_${randomUUID()}`}
      )
    `;
    if (!result) throw new Error("SOURCE_LINK_COMPLETION_FAILED");
    return Object.freeze({ ...result, affectedFitmentIds: Object.freeze([...result.affectedFitmentIds]) });
  },
  invalidate: async (fitmentIds) => {
    const contexts = await Promise.all(fitmentIds.map(getCatalogInvalidationContext));
    const tags = stableUnique(contexts.flatMap(catalogTagsForContext));
    const attempt = await attemptCatalogueCacheInvalidation(tags);
    return Object.freeze({ affectedTags: attempt.affectedTags, failedTags: attempt.failedTags });
  },
};

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
