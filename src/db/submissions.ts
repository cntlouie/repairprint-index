import { eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AnonymousSubmissionKind } from "@/domain/submissions";
import type { SubmissionRateBucket } from "@/lib/submission-security";
import { SubmissionIdempotencyConflictError } from "@/lib/submissions";
import {
  submissionEmailFollowUps,
  submissionRateLimitBuckets,
  submissions,
} from "./schema";
import type * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

export const SUBMISSION_INTAKE_VERSION = 1;
export const CONTRIBUTOR_TERMS_VERSION = "wp08-operating-draft-v1";
export const PRIVACY_NOTICE_VERSION = "wp08-operating-draft-v1";
export const CONTACT_CONSENT_VERSION = "wp08-email-follow-up-v1";

export type PersistAnonymousSubmissionInput = Readonly<{
  challengeVerifiedAt: Date;
  contactEmail?: string;
  consentedAt: Date;
  contentFingerprint: string;
  contributorKey: string;
  idempotencyKeyHash: string;
  kind: AnonymousSubmissionKind;
  payload: Record<string, unknown>;
  requestFingerprint: string;
}>;

export async function persistAnonymousSubmission(
  input: PersistAnonymousSubmissionInput,
  database: Database,
): Promise<Readonly<{ duplicate: boolean; id: string }>> {
  return database.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(submissions)
      .values({
        challengeProvider: "turnstile",
        challengeVerifiedAt: input.challengeVerifiedAt,
        consentedAt: input.consentedAt,
        contactConsentVersion: input.contactEmail ? CONTACT_CONSENT_VERSION : null,
        contactConsentedAt: input.contactEmail ? input.consentedAt : null,
        contactEmail: input.contactEmail ?? null,
        contentFingerprint: input.contentFingerprint,
        contributorKey: input.contributorKey,
        contributorTermsVersion: CONTRIBUTOR_TERMS_VERSION,
        idempotencyKeyHash: input.idempotencyKeyHash,
        intakeVersion: SUBMISSION_INTAKE_VERSION,
        kind: input.kind,
        payload: input.payload,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        requestFingerprint: input.requestFingerprint,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: submissions.id });

    if (!created) {
      const [idempotent] = await transaction
        .select({ id: submissions.id, requestFingerprint: submissions.requestFingerprint })
        .from(submissions)
        .where(eq(submissions.idempotencyKeyHash, input.idempotencyKeyHash))
        .limit(1);
      if (idempotent) {
        if (idempotent.requestFingerprint !== input.requestFingerprint) {
          throw new SubmissionIdempotencyConflictError();
        }
        return Object.freeze({ duplicate: true, id: idempotent.id });
      }

      const [sameContributorContent] = await transaction
        .select({ id: submissions.id })
        .from(submissions)
        .where(sql`${submissions.kind} = ${input.kind}
          AND ${submissions.contributorKey} = ${input.contributorKey}
          AND ${submissions.contentFingerprint} = ${input.contentFingerprint}
          AND ${submissions.status} IN ('pending', 'in_review')`)
        .limit(1);
      if (!sameContributorContent) {
        throw new SubmissionIdempotencyConflictError();
      }
      return Object.freeze({ duplicate: true, id: sameContributorContent.id });
    }

    if (input.contactEmail) {
      await transaction.insert(submissionEmailFollowUps).values({
        availableAt: null,
        followUpKey: `submission:${created.id}:contact-follow-up`,
        status: "awaiting_event",
        submissionId: created.id,
        templateKey: input.kind === "missing_part" ? "missing-part-match-alert" : "moderator-follow-up",
      });
    }

    return Object.freeze({ duplicate: false, id: created.id });
  });
}

export async function triggerSubmissionEmailFollowUp(
  submissionId: string,
  database: Database,
  now = new Date(),
): Promise<Readonly<{ followUpId: string }>> {
  const [queued] = await database
    .update(submissionEmailFollowUps)
    .set({ availableAt: now, status: "pending", updatedAt: now })
    .where(sql`${submissionEmailFollowUps.submissionId} = ${submissionId}
      AND ${submissionEmailFollowUps.status} = 'awaiting_event'`)
    .returning({ followUpId: submissionEmailFollowUps.id });
  if (!queued) throw new Error("SUBMISSION_FOLLOW_UP_NOT_AVAILABLE");
  return Object.freeze(queued);
}

export async function consumeSubmissionRateLimitBuckets(
  buckets: readonly SubmissionRateBucket[],
  now = new Date(),
  database: Database,
): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
  return database.transaction(async (transaction) => {
    let retryAfterSeconds = 0;

    for (const bucket of buckets) {
      const rows = await transaction
        .insert(submissionRateLimitBuckets)
        .values({
          expiresAt: bucket.expiresAt,
          scope: bucket.scope,
          subjectHash: bucket.subjectHash,
          windowSeconds: bucket.windowSeconds,
          windowStartedAt: bucket.windowStartedAt,
        })
        .onConflictDoUpdate({
          target: [
            submissionRateLimitBuckets.scope,
            submissionRateLimitBuckets.subjectHash,
            submissionRateLimitBuckets.windowStartedAt,
            submissionRateLimitBuckets.windowSeconds,
          ],
          set: {
            requestCount: sql`${submissionRateLimitBuckets.requestCount} + 1`,
            updatedAt: now,
          },
          setWhere: lt(submissionRateLimitBuckets.requestCount, bucket.limit),
        })
        .returning({ requestCount: submissionRateLimitBuckets.requestCount });

      if (rows.length === 0) {
        const retryAt = bucket.windowStartedAt.getTime() + bucket.windowSeconds * 1000;
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)));
      }
    }

    await transaction
      .delete(submissionRateLimitBuckets)
      .where(lt(submissionRateLimitBuckets.expiresAt, now));

    return Object.freeze({ allowed: retryAfterSeconds === 0, retryAfterSeconds });
  });
}
