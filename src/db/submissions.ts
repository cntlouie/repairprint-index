import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
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
  contactRetentionExpiresAt?: Date;
  retentionExpiresAt: Date;
  retentionPolicyVersion: string;
  requestFingerprint: string;
}>;

export type SubmissionFollowUpEvent = Readonly<{
  eventId: string;
  kind: "matching_publication" | "moderator_question";
}>;

export async function persistAnonymousSubmission(
  input: PersistAnonymousSubmissionInput,
  database: Database,
): Promise<Readonly<{ duplicate: boolean; id: string; receiptId: string }>> {
  if (input.contactEmail && !input.contactRetentionExpiresAt) {
    throw new Error("SUBMISSION_RETENTION_CONTRACT_INVALID");
  }
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
        contactRetentionExpiresAt: input.contactEmail ? input.contactRetentionExpiresAt : null,
        contentFingerprint: input.contentFingerprint,
        contributorKey: input.contributorKey,
        contributorTermsVersion: CONTRIBUTOR_TERMS_VERSION,
        idempotencyKeyHash: input.idempotencyKeyHash,
        intakeVersion: SUBMISSION_INTAKE_VERSION,
        kind: input.kind,
        payload: input.payload,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        retentionExpiresAt: input.retentionExpiresAt,
        retentionPolicyVersion: input.retentionPolicyVersion,
        requestFingerprint: input.requestFingerprint,
      })
      .onConflictDoNothing()
      .returning({ id: submissions.id, receiptId: submissions.receiptId });

    if (!created) {
      const [idempotent] = await transaction
        .select({
          id: submissions.id,
          receiptId: submissions.receiptId,
          requestFingerprint: submissions.requestFingerprint,
        })
        .from(submissions)
        .where(and(
          eq(submissions.kind, input.kind),
          eq(submissions.contributorKey, input.contributorKey),
          eq(submissions.idempotencyKeyHash, input.idempotencyKeyHash),
        ))
        .limit(1);
      if (idempotent) {
        if (idempotent.requestFingerprint !== input.requestFingerprint) {
          throw new SubmissionIdempotencyConflictError();
        }
        return Object.freeze({ duplicate: true, id: idempotent.id, receiptId: idempotent.receiptId });
      }

      const [sameContributorContent] = await transaction
        .select({ id: submissions.id, receiptId: submissions.receiptId })
        .from(submissions)
        .where(sql`${submissions.kind} = ${input.kind}
          AND ${submissions.contributorKey} = ${input.contributorKey}
          AND ${submissions.contentFingerprint} = ${input.contentFingerprint}
          AND ${submissions.status} IN ('pending', 'in_review')`)
        .limit(1);
      if (!sameContributorContent) {
        throw new SubmissionIdempotencyConflictError();
      }
      return Object.freeze({
        duplicate: true,
        id: sameContributorContent.id,
        receiptId: sameContributorContent.receiptId,
      });
    }

    return Object.freeze({ duplicate: false, id: created.id, receiptId: created.receiptId });
  });
}

export async function triggerSubmissionEmailFollowUp(
  submissionId: string,
  event: SubmissionFollowUpEvent,
  database: Database,
  now = new Date(),
): Promise<Readonly<{ duplicate: boolean; followUpId: string }>> {
  const templateKey = followUpTemplate(event);
  const followUpKey = `submission:${submissionId}:${event.kind}:${event.eventId}`;

  return database.transaction(async (transaction) => {
    const [submission] = await transaction
      .select({ kind: submissions.kind })
      .from(submissions)
      .where(and(
        eq(submissions.id, submissionId),
        eq(submissions.intakeVersion, SUBMISSION_INTAKE_VERSION),
        sql`${submissions.status} IN ('pending', 'in_review')`,
        isNotNull(submissions.contactEmail),
        eq(submissions.contactConsentVersion, CONTACT_CONSENT_VERSION),
        gt(submissions.contactRetentionExpiresAt, now),
        gt(submissions.retentionExpiresAt, now),
      ))
      .limit(1)
      .for("update");
    if (!submission || (event.kind === "matching_publication" && submission.kind !== "missing_part")) {
      throw new Error("SUBMISSION_FOLLOW_UP_NOT_AVAILABLE");
    }

    const [queued] = await transaction
      .insert(submissionEmailFollowUps)
      .values({
        availableAt: now,
        followUpKey,
        qualifyingEvent: event.kind,
        submissionId,
        templateKey,
      })
      .onConflictDoNothing({ target: submissionEmailFollowUps.followUpKey })
      .returning({ followUpId: submissionEmailFollowUps.id });
    if (queued) return Object.freeze({ duplicate: false, followUpId: queued.followUpId });

    const [existing] = await transaction
      .select({ followUpId: submissionEmailFollowUps.id })
      .from(submissionEmailFollowUps)
      .where(and(
        eq(submissionEmailFollowUps.followUpKey, followUpKey),
        eq(submissionEmailFollowUps.qualifyingEvent, event.kind),
        eq(submissionEmailFollowUps.submissionId, submissionId),
        eq(submissionEmailFollowUps.templateKey, templateKey),
      ))
      .limit(1);
    if (!existing) throw new Error("SUBMISSION_FOLLOW_UP_NOT_AVAILABLE");
    return Object.freeze({ duplicate: true, followUpId: existing.followUpId });
  });
}

export async function cleanupExpiredAnonymousSubmissions(
  database: Database,
  now = new Date(),
  limit = 100,
): Promise<Readonly<{ deletedSubmissions: number; redactedContacts: number }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(now.getTime())) {
    throw new Error("SUBMISSION_RETENTION_CLEANUP_INVALID");
  }

  return database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        contactRetentionExpiresAt: submissions.contactRetentionExpiresAt,
        id: submissions.id,
        retentionExpiresAt: submissions.retentionExpiresAt,
      })
      .from(submissions)
      .where(and(
        eq(submissions.intakeVersion, SUBMISSION_INTAKE_VERSION),
        or(
          lte(submissions.retentionExpiresAt, now),
          and(isNotNull(submissions.contactEmail), lte(submissions.contactRetentionExpiresAt, now)),
        ),
      ))
      .orderBy(
        asc(sql`LEAST(${submissions.retentionExpiresAt}, COALESCE(${submissions.contactRetentionExpiresAt}, ${submissions.retentionExpiresAt}))`),
        asc(submissions.id),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    const fullyExpiredIds = candidates
      .filter((candidate) => candidate.retentionExpiresAt !== null && candidate.retentionExpiresAt <= now)
      .map((candidate) => candidate.id);
    const contactExpiredIds = candidates
      .filter((candidate) => !fullyExpiredIds.includes(candidate.id)
        && candidate.contactRetentionExpiresAt !== null
        && candidate.contactRetentionExpiresAt <= now)
      .map((candidate) => candidate.id);
    const allAffectedIds = [...fullyExpiredIds, ...contactExpiredIds];

    if (allAffectedIds.length > 0) {
      await transaction
        .delete(submissionEmailFollowUps)
        .where(inArray(submissionEmailFollowUps.submissionId, allAffectedIds));
    }

    let deletedSubmissions = 0;
    if (fullyExpiredIds.length > 0) {
      const deleted = await transaction
        .delete(submissions)
        .where(and(inArray(submissions.id, fullyExpiredIds), lte(submissions.retentionExpiresAt, now)))
        .returning({ id: submissions.id });
      deletedSubmissions = deleted.length;
    }

    let redactedContacts = 0;
    for (const id of contactExpiredIds) {
      const redacted = await transaction
        .update(submissions)
        .set({
          contactConsentVersion: null,
          contactConsentedAt: null,
          contactEmail: null,
          contactRetentionExpiresAt: null,
          contributorKey: randomDigest(),
          requestFingerprint: randomDigest(),
          updatedAt: now,
        })
        .where(and(
          eq(submissions.id, id),
          isNotNull(submissions.contactEmail),
          lte(submissions.contactRetentionExpiresAt, now),
        ))
        .returning({ id: submissions.id });
      redactedContacts += redacted.length;
    }

    return Object.freeze({ deletedSubmissions, redactedContacts });
  });
}

function followUpTemplate(event: SubmissionFollowUpEvent): string {
  if (event.kind !== "matching_publication" && event.kind !== "moderator_question") {
    throw new Error("SUBMISSION_FOLLOW_UP_EVENT_INVALID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.eventId)) {
    throw new Error("SUBMISSION_FOLLOW_UP_EVENT_INVALID");
  }
  return event.kind === "matching_publication" ? "missing-part-match-alert" : "moderator-follow-up";
}

function randomDigest(): string {
  return randomBytes(32).toString("hex");
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
