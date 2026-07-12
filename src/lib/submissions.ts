import type { AnonymousSubmissionKind } from "@/domain/submissions";
import { SubmissionIntakeError, type SubmissionRateBucket } from "./submission-security";

export class SubmissionIdempotencyConflictError extends Error {
  constructor() {
    super("IDEMPOTENCY_KEY_REUSED");
    this.name = "SubmissionIdempotencyConflictError";
  }
}

export type AnonymousSubmissionPersistence = Readonly<{
  consumeRateLimits: (
    buckets: readonly SubmissionRateBucket[],
    now?: Date,
  ) => Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>>;
  persist: (input: Readonly<{
    challengeVerifiedAt: Date;
    contactEmail?: string;
    consentedAt: Date;
    contentFingerprint: string;
    contributorKey: string;
    idempotencyKeyHash: string;
    kind: AnonymousSubmissionKind;
    payload: Record<string, unknown>;
    requestFingerprint: string;
  }>) => Promise<Readonly<{ duplicate: boolean; id: string }>>;
}>;

export async function productionSubmissionPersistence(): Promise<AnonymousSubmissionPersistence> {
  if (process.env.DEMO_MODE !== "false") {
    return {
      consumeRateLimits: async () => Object.freeze({ allowed: true, retryAfterSeconds: 0 }),
      persist: async () => Object.freeze({ duplicate: false, id: `demo-${crypto.randomUUID()}` }),
    };
  }

  if (!process.env.DATABASE_URL) throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);

  const [repository, database] = await Promise.all([
    import("@/db/submissions"),
    import("@/db/client"),
  ]);
  return {
    consumeRateLimits: (buckets, now) => repository.consumeSubmissionRateLimitBuckets(buckets, now, database.db),
    persist: (input) => repository.persistAnonymousSubmission(input, database.db),
  };
}
