import type { AnonymousSubmissionKind } from "@/domain/submissions";
import { SubmissionIntakeError, type SubmissionRateBucket } from "./submission-security";

export class SubmissionIdempotencyConflictError extends Error {
  constructor() {
    super("IDEMPOTENCY_KEY_REUSED");
    this.name = "SubmissionIdempotencyConflictError";
  }
}

const DEMO_RETENTION_POLICY_VERSION = "wp08-demo-retention-v1";
const DEMO_SUBMISSION_RETENTION_DAYS = 30;
const DEMO_CONTACT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 3650;

export type SubmissionRetentionPolicy = Readonly<{
  contactRetentionExpiresAt?: Date;
  retentionExpiresAt: Date;
  retentionPolicyVersion: string;
}>;

export function resolveSubmissionRetentionPolicy(
  now: Date,
  hasContact: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): SubmissionRetentionPolicy {
  const demoMode = environment.DEMO_MODE !== "false";
  const retentionPolicyVersion = demoMode
    ? (environment.SUBMISSION_RETENTION_POLICY_VERSION?.trim() || DEMO_RETENTION_POLICY_VERSION)
    : environment.SUBMISSION_RETENTION_POLICY_VERSION?.trim();
  const submissionDays = retentionDays(
    environment.SUBMISSION_RETENTION_DAYS,
    demoMode ? DEMO_SUBMISSION_RETENTION_DAYS : undefined,
  );
  const contactDays = retentionDays(
    environment.SUBMISSION_CONTACT_RETENTION_DAYS,
    demoMode ? DEMO_CONTACT_RETENTION_DAYS : undefined,
  );

  if (
    !retentionPolicyVersion
    || retentionPolicyVersion.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(retentionPolicyVersion)
    || submissionDays === undefined
    || contactDays === undefined
    || contactDays > submissionDays
    || !Number.isFinite(now.getTime())
  ) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }

  const retentionExpiresAt = addDays(now, submissionDays);
  const contactRetentionExpiresAt = hasContact ? addDays(now, contactDays) : undefined;
  return Object.freeze({ contactRetentionExpiresAt, retentionExpiresAt, retentionPolicyVersion });
}

export function isSubmissionRetentionConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveSubmissionRetentionPolicy(new Date(0), true, environment);
    return true;
  } catch {
    return false;
  }
}

function retentionDays(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_RETENTION_DAYS ? parsed : undefined;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(result.getTime())) throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  return result;
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
    contactRetentionExpiresAt?: Date;
    retentionExpiresAt: Date;
    retentionPolicyVersion: string;
    requestFingerprint: string;
  }>) => Promise<Readonly<{ duplicate: boolean; id: string; receiptId: string }>>;
}>;

export async function productionSubmissionPersistence(): Promise<AnonymousSubmissionPersistence> {
  if (process.env.DEMO_MODE !== "false") {
    return {
      consumeRateLimits: async () => Object.freeze({ allowed: true, retryAfterSeconds: 0 }),
      persist: async () => Object.freeze({
        duplicate: false,
        id: `demo-${crypto.randomUUID()}`,
        receiptId: crypto.randomUUID(),
      }),
    };
  }

  if (!process.env.SUBMISSION_DATABASE_URL) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }

  const [repository, submissionClient] = await Promise.all([
    import("@/db/submissions"),
    import("@/db/submission-client"),
  ]);
  const database = await submissionClient.getSubmissionDatabase();
  return {
    consumeRateLimits: (buckets, now) => repository.consumeSubmissionRateLimitBuckets(buckets, now, database),
    persist: (input) => repository.persistAnonymousSubmission(input, database),
  };
}
