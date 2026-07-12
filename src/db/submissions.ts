import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AnonymousSubmissionKind } from "@/domain/submissions";
import {
  CONTACT_CONSENT_VERSION,
  CONTRIBUTOR_TERMS_VERSION,
  PRIVACY_NOTICE_VERSION,
} from "@/lib/submission-constants";
import type { SubmissionRateBucket } from "@/lib/submission-security";
import { SubmissionIdempotencyConflictError } from "@/lib/submissions";
import {
  submissionEmailFollowUps,
  submissionIdempotencyBindings,
  submissionRateLimitBuckets,
  submissions,
} from "./schema";
import type * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

export const SUBMISSION_INTAKE_VERSION = 1;
export {
  CONTACT_CONSENT_VERSION,
  CONTRIBUTOR_TERMS_VERSION,
  PRIVACY_NOTICE_VERSION,
} from "@/lib/submission-constants";

export type PersistAnonymousSubmissionInput = Readonly<{
  challengeVerifiedAt: Date;
  contactEmail?: string;
  consentedAt: Date;
  contentFingerprint: string;
  contributorKey: string;
  idempotencyActorKey: string;
  idempotencyKeyHash: string;
  kind: AnonymousSubmissionKind;
  payload: Record<string, unknown>;
  contactRetentionExpiresAt?: Date;
  retentionExpiresAt: Date;
  retentionPolicyVersion: string;
  requestFingerprint: string;
}>;

export type FindAnonymousSubmissionIdempotencyInput = Readonly<{
  idempotencyActorKey: string;
  idempotencyKeyHash: string;
  kind: AnonymousSubmissionKind;
}>;

export type AnonymousSubmissionIdempotency = Readonly<{
  receiptId: string;
  requestFingerprint: string;
}>;

type SubmissionDatabaseReader = Pick<Database, "select">;

type AnonymousSubmissionIdempotencyRow = AnonymousSubmissionIdempotency & Readonly<{
  id: string;
}>;

class SubmissionIdempotencyBindingRaceError extends Error {
  constructor() {
    super("SUBMISSION_IDEMPOTENCY_BINDING_RACE");
    this.name = "SubmissionIdempotencyBindingRaceError";
  }
}

export type SubmissionFollowUpEvent = Readonly<{
  eventId: string;
  kind: "matching_publication" | "moderator_question";
}>;

/**
 * Resolve a retry only inside the server-derived actor namespace.
 *
 * The deliberately narrow result is safe for the intake handler's preflight:
 * it exposes neither the private row id nor payload, contact, or contributor
 * identity. The request fingerprint must still match before the receipt can be
 * returned to a caller.
 */
export async function findAnonymousSubmissionIdempotency(
  input: FindAnonymousSubmissionIdempotencyInput,
  database: SubmissionDatabaseReader,
): Promise<AnonymousSubmissionIdempotency | null> {
  const existing = await findAnonymousSubmissionIdempotencyRow(input, database);
  if (!existing) return null;
  return Object.freeze({
    receiptId: existing.receiptId,
    requestFingerprint: existing.requestFingerprint,
  });
}

export async function persistAnonymousSubmission(
  input: PersistAnonymousSubmissionInput,
  database: Database,
): Promise<Readonly<{
  duplicate: boolean;
  id: string;
  receiptId: string;
  requestFingerprint: string;
}>> {
  if (input.contactEmail && !input.contactRetentionExpiresAt) {
    throw new Error("SUBMISSION_RETENTION_CONTRACT_INVALID");
  }
  try {
    return await database.transaction(async (transaction) => {
      const idempotent = await findAnonymousSubmissionIdempotencyRow(input, transaction);
      if (idempotent) {
        if (idempotent.requestFingerprint !== input.requestFingerprint) {
          throw new SubmissionIdempotencyConflictError();
        }
        return Object.freeze({
          duplicate: true,
          id: idempotent.id,
          receiptId: idempotent.receiptId,
          requestFingerprint: idempotent.requestFingerprint,
        });
      }

      const createdRows = await transaction.execute<{ id: string; receiptId: string }>(sql`
        INSERT INTO submissions (
          kind,
          payload,
          intake_version,
          contributor_key,
          content_fingerprint,
          contributor_terms_version,
          privacy_notice_version,
          consented_at,
          challenge_provider,
          challenge_verified_at,
          contact_email,
          contact_consent_version,
          contact_consented_at,
          retention_policy_version,
          retention_expires_at,
          contact_retention_expires_at
        ) VALUES (
          ${input.kind},
          ${JSON.stringify(input.payload)}::jsonb,
          ${SUBMISSION_INTAKE_VERSION},
          ${input.contributorKey},
          ${input.contentFingerprint},
          ${CONTRIBUTOR_TERMS_VERSION},
          ${PRIVACY_NOTICE_VERSION},
          ${input.consentedAt.toISOString()}::timestamptz,
          'turnstile',
          ${input.challengeVerifiedAt.toISOString()}::timestamptz,
          ${input.contactEmail ?? null},
          ${input.contactEmail ? CONTACT_CONSENT_VERSION : null},
          ${input.contactEmail ? input.consentedAt.toISOString() : null}::timestamptz,
          ${input.retentionPolicyVersion},
          ${input.retentionExpiresAt.toISOString()}::timestamptz,
          ${input.contactEmail ? input.contactRetentionExpiresAt!.toISOString() : null}::timestamptz
        )
        ON CONFLICT DO NOTHING
        RETURNING id, receipt_id AS "receiptId"
      `);
      const created = createdRows[0];
      let target = created;

      if (!target) {
        const [sameContributorContent] = await transaction
          .select({ id: submissions.id, receiptId: submissions.receiptId })
          .from(submissions)
          .where(sql`${submissions.kind} = ${input.kind}
            AND ${submissions.contributorKey} = ${input.contributorKey}
            AND ${submissions.contentFingerprint} = ${input.contentFingerprint}
            AND ${submissions.status} IN ('pending', 'in_review')`)
          .limit(1);
        if (!sameContributorContent) throw new SubmissionIdempotencyConflictError();
        target = sameContributorContent;
      }

      const boundRows = await transaction.execute<{ submissionId: string }>(sql`
        INSERT INTO submission_idempotency_bindings (
          kind,
          idempotency_actor_key,
          idempotency_key_hash,
          submission_id,
          request_fingerprint
        ) VALUES (
          ${input.kind},
          ${input.idempotencyActorKey},
          ${input.idempotencyKeyHash},
          ${target.id},
          ${input.requestFingerprint}
        )
        ON CONFLICT (kind, idempotency_actor_key, idempotency_key_hash) DO NOTHING
        RETURNING submission_id AS "submissionId"
      `);
      if (!boundRows[0]) throw new SubmissionIdempotencyBindingRaceError();

      return Object.freeze({
        duplicate: !created,
        id: target.id,
        receiptId: target.receiptId,
        requestFingerprint: input.requestFingerprint,
      });
    });
  } catch (error) {
    if (!(error instanceof SubmissionIdempotencyBindingRaceError)) throw error;
    const winner = await findAnonymousSubmissionIdempotencyRow(input, database);
    if (!winner || winner.requestFingerprint !== input.requestFingerprint) {
      throw new SubmissionIdempotencyConflictError();
    }
    return Object.freeze({
      duplicate: true,
      id: winner.id,
      receiptId: winner.receiptId,
      requestFingerprint: winner.requestFingerprint,
    });
  }
}

async function findAnonymousSubmissionIdempotencyRow(
  input: FindAnonymousSubmissionIdempotencyInput,
  database: SubmissionDatabaseReader,
): Promise<AnonymousSubmissionIdempotencyRow | null> {
  const [existing] = await database
    .select({
      id: submissions.id,
      receiptId: submissions.receiptId,
      requestFingerprint: submissionIdempotencyBindings.requestFingerprint,
    })
    .from(submissionIdempotencyBindings)
    .innerJoin(submissions, and(
      eq(submissions.id, submissionIdempotencyBindings.submissionId),
      eq(submissions.kind, submissionIdempotencyBindings.kind),
    ))
    .where(and(
      eq(submissions.intakeVersion, SUBMISSION_INTAKE_VERSION),
      eq(submissionIdempotencyBindings.kind, input.kind),
      eq(submissionIdempotencyBindings.idempotencyActorKey, input.idempotencyActorKey),
      eq(submissionIdempotencyBindings.idempotencyKeyHash, input.idempotencyKeyHash),
    ))
    .limit(1);
  if (!existing?.requestFingerprint) return null;
  return Object.freeze({
    id: existing.id,
    receiptId: existing.receiptId,
    requestFingerprint: existing.requestFingerprint,
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

    const queuedRows = await transaction.execute<{ followUpId: string }>(sql`
      INSERT INTO submission_email_follow_ups (
        submission_id,
        follow_up_key,
        qualifying_event,
        template_key,
        available_at
      ) VALUES (
        ${submissionId},
        ${followUpKey},
        ${event.kind},
        ${templateKey},
        ${now.toISOString()}::timestamptz
      )
      ON CONFLICT (follow_up_key) DO NOTHING
      RETURNING id AS "followUpId"
    `);
    const queued = queuedRows[0];
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
      await transaction
        .update(submissionIdempotencyBindings)
        .set({ requestFingerprint: randomDigest() })
        .where(eq(submissionIdempotencyBindings.submissionId, id));
      const redacted = await transaction
        .update(submissions)
        .set({
          contactConsentVersion: null,
          contactConsentedAt: null,
          contactEmail: null,
          contactRetentionExpiresAt: null,
          contributorKey: randomDigest(),
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
      const rows = await transaction.execute<{ requestCount: number }>(sql`
        INSERT INTO submission_rate_limit_buckets (
          scope,
          subject_hash,
          window_started_at,
          window_seconds,
          expires_at
        ) VALUES (
          ${bucket.scope},
          ${bucket.subjectHash},
          ${bucket.windowStartedAt.toISOString()}::timestamptz,
          ${bucket.windowSeconds},
          ${bucket.expiresAt.toISOString()}::timestamptz
        )
        ON CONFLICT (scope, subject_hash, window_started_at, window_seconds)
        DO UPDATE SET
          request_count = submission_rate_limit_buckets.request_count + 1,
          updated_at = ${now.toISOString()}::timestamptz
        WHERE submission_rate_limit_buckets.request_count < ${bucket.limit}
        RETURNING request_count AS "requestCount"
      `);

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
