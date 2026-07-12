import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

import type { AnonymousSubmissionKind } from "@/domain/submissions";
import {
  CONTACT_CONSENT_VERSION,
} from "@/lib/submission-constants";
import {
  assertSubmissionHmacKeyPin,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
  SUBMISSION_HMAC_KEY_PIN_LOCK_CLASS,
  SUBMISSION_HMAC_KEY_PIN_LOCK_OBJECT,
} from "@/lib/submission-key-pin";
import type { SubmissionRateBucket } from "@/lib/submission-security";
import { SubmissionIdempotencyConflictError } from "@/lib/submissions";
import {
  submissionEmailFollowUps,
  submissionHmacKeyPin,
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
  contactConsentVersion: string;
  contactDigest?: string;
  contactEmail?: string;
  contactPresent: boolean;
  consentedAt: Date;
  contributionConsent: boolean;
  contentFingerprint: string;
  contributorKey: string;
  contributorTermsVersion: string;
  emailFollowUpConsent: boolean;
  hmacVersion: string;
  idempotencyActorKey: string;
  idempotencyKeyHash: string;
  kind: AnonymousSubmissionKind;
  payload: Record<string, unknown>;
  privacyConsent: boolean;
  privacyNoticeVersion: string;
  semanticPayload: Record<string, unknown>;
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
  intakeId: string;
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

export async function verifySubmissionHmacKeyPin(database: SubmissionDatabaseReader): Promise<void> {
  const [pin] = await database
    .select({
      hmacVersion: submissionHmacKeyPin.hmacVersion,
      keyCommitment: submissionHmacKeyPin.keyCommitment,
    })
    .from(submissionHmacKeyPin)
    .where(eq(submissionHmacKeyPin.singleton, true))
    .limit(1);
  assertSubmissionHmacKeyPin(pin);
}

async function lockAndVerifySubmissionHmacKeyPin(database: Database): Promise<void> {
  await database.execute(sql`
    SELECT pg_catalog.pg_advisory_xact_lock_shared(
      ${SUBMISSION_HMAC_KEY_PIN_LOCK_CLASS},
      ${SUBMISSION_HMAC_KEY_PIN_LOCK_OBJECT}
    )
  `);
  const [pin] = await database
    .select({
      hmacVersion: submissionHmacKeyPin.hmacVersion,
      keyCommitment: submissionHmacKeyPin.keyCommitment,
    })
    .from(submissionHmacKeyPin)
    .where(eq(submissionHmacKeyPin.singleton, true))
    .limit(1);
  assertSubmissionHmacKeyPin(pin);
}

/** Resolve a retry only inside the server-derived actor namespace. */
export async function findAnonymousSubmissionIdempotency(
  input: FindAnonymousSubmissionIdempotencyInput,
  database: SubmissionDatabaseReader,
): Promise<AnonymousSubmissionIdempotency | null> {
  const existing = await findAnonymousSubmissionIdempotencyRow(input, database);
  if (!existing) return null;
  return Object.freeze({
    intakeId: existing.intakeId,
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
  intakeId: string;
  receiptId: string;
  requestFingerprint: string;
}>> {
  const hasContact = Boolean(input.contactEmail);
  if (
    input.hmacVersion !== SUBMISSION_HMAC_ALGORITHM_VERSION
    || input.contactPresent !== hasContact
    || hasContact !== Boolean(input.contactDigest)
    || hasContact !== Boolean(input.contactRetentionExpiresAt)
  ) {
    throw new Error("SUBMISSION_INTAKE_CONTRACT_INVALID");
  }

  try {
    return await database.transaction(async (transaction) => {
      await lockAndVerifySubmissionHmacKeyPin(transaction);
      const idempotent = await findAnonymousSubmissionIdempotencyRow(input, transaction);
      if (idempotent) {
        if (idempotent.requestFingerprint !== input.requestFingerprint) {
          throw new SubmissionIdempotencyConflictError();
        }
        return Object.freeze({
          duplicate: true,
          id: idempotent.id,
          intakeId: idempotent.intakeId,
          receiptId: idempotent.receiptId,
          requestFingerprint: idempotent.requestFingerprint,
        });
      }

      const createdRows = await transaction.execute<{ id: string; receiptId: string }>(sql`
        INSERT INTO submissions (
          kind,
          payload,
          intake_version,
          hmac_version,
          contributor_key,
          content_fingerprint
        ) VALUES (
          ${input.kind},
          ${JSON.stringify(input.semanticPayload)}::jsonb,
          ${SUBMISSION_INTAKE_VERSION},
          ${input.hmacVersion},
          ${input.contributorKey},
          ${input.contentFingerprint}
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
          .where(and(
            eq(submissions.kind, input.kind),
            eq(submissions.intakeVersion, SUBMISSION_INTAKE_VERSION),
            eq(submissions.hmacVersion, input.hmacVersion),
            eq(submissions.contributorKey, input.contributorKey),
            eq(submissions.contentFingerprint, input.contentFingerprint),
            sql`${submissions.status} IN ('pending', 'in_review')`,
          ))
          .limit(1);
        if (!sameContributorContent) throw new SubmissionIdempotencyConflictError();
        target = sameContributorContent;
      }

      const boundRows = await transaction.execute<{ intakeId: string }>(sql`
        INSERT INTO submission_idempotency_bindings (
          kind,
          idempotency_actor_key,
          idempotency_key_hash,
          submission_id,
          receipt_id,
          intake_version,
          hmac_version,
          request_fingerprint,
          payload,
          privacy_consent,
          contribution_consent,
          email_follow_up_consent,
          contributor_terms_version,
          privacy_notice_version,
          contact_consent_version,
          retention_policy_version,
          accepted_at,
          challenge_provider,
          challenge_verified_at,
          contact_present,
          contact_digest,
          retention_expires_at,
          contact_retention_expires_at
        ) VALUES (
          ${input.kind},
          ${input.idempotencyActorKey},
          ${input.idempotencyKeyHash},
          ${target.id},
          ${target.receiptId},
          ${SUBMISSION_INTAKE_VERSION},
          ${input.hmacVersion},
          ${input.requestFingerprint},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.privacyConsent},
          ${input.contributionConsent},
          ${input.emailFollowUpConsent},
          ${input.contributorTermsVersion},
          ${input.privacyNoticeVersion},
          ${input.contactConsentVersion},
          ${input.retentionPolicyVersion},
          ${input.consentedAt.toISOString()}::timestamptz,
          'turnstile',
          ${input.challengeVerifiedAt.toISOString()}::timestamptz,
          ${input.contactPresent},
          ${input.contactDigest ?? null},
          ${input.retentionExpiresAt.toISOString()}::timestamptz,
          ${input.contactRetentionExpiresAt?.toISOString() ?? null}::timestamptz
        )
        ON CONFLICT (kind, idempotency_actor_key, idempotency_key_hash) DO NOTHING
        RETURNING id AS "intakeId"
      `);
      const bound = boundRows[0];
      if (!bound) throw new SubmissionIdempotencyBindingRaceError();

      if (input.contactEmail && input.contactDigest) {
        await transaction.execute(sql`
          INSERT INTO submission_intake_contacts (
            intake_id,
            contact_present,
            contact_digest,
            contact_email
          ) VALUES (
            ${bound.intakeId},
            true,
            ${input.contactDigest},
            ${input.contactEmail}
          )
        `);
      }

      return Object.freeze({
        duplicate: !created,
        id: target.id,
        intakeId: bound.intakeId,
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
      intakeId: winner.intakeId,
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
      intakeId: submissionIdempotencyBindings.id,
      receiptId: submissionIdempotencyBindings.receiptId,
      requestFingerprint: submissionIdempotencyBindings.requestFingerprint,
    })
    .from(submissionIdempotencyBindings)
    .innerJoin(submissions, and(
      eq(submissions.id, submissionIdempotencyBindings.submissionId),
      eq(submissions.kind, submissionIdempotencyBindings.kind),
      eq(submissions.intakeVersion, submissionIdempotencyBindings.intakeVersion),
      eq(submissions.hmacVersion, submissionIdempotencyBindings.hmacVersion),
      eq(submissions.receiptId, submissionIdempotencyBindings.receiptId),
    ))
    .where(and(
      eq(submissionIdempotencyBindings.intakeVersion, SUBMISSION_INTAKE_VERSION),
      eq(submissionIdempotencyBindings.hmacVersion, SUBMISSION_HMAC_ALGORITHM_VERSION),
      eq(submissionIdempotencyBindings.kind, input.kind),
      eq(submissionIdempotencyBindings.idempotencyActorKey, input.idempotencyActorKey),
      eq(submissionIdempotencyBindings.idempotencyKeyHash, input.idempotencyKeyHash),
    ))
    .limit(1);
  if (!existing?.requestFingerprint) return null;
  return Object.freeze(existing);
}

export async function triggerSubmissionEmailFollowUp(
  intakeId: string,
  event: SubmissionFollowUpEvent,
  database: Database,
): Promise<Readonly<{ duplicate: boolean; followUpId: string }>> {
  const templateKey = followUpTemplate(event);
  const canonicalEventId = canonicalSubmissionFollowUpEventId(event.eventId);
  const followUpKey = `intake:${intakeId}:${event.kind}:${canonicalEventId}`;

  return database.transaction(async (transaction) => {
    await lockAndVerifySubmissionHmacKeyPin(transaction);
    const eligible = await transaction.execute<{ kind: AnonymousSubmissionKind; submissionId: string }>(sql`
      SELECT parent.kind, intake.submission_id AS "submissionId"
      FROM submission_idempotency_bindings AS intake
      INNER JOIN submissions AS parent
        ON parent.id = intake.submission_id
        AND parent.kind = intake.kind
        AND parent.receipt_id = intake.receipt_id
      INNER JOIN submission_intake_contacts AS contact ON contact.intake_id = intake.id
      WHERE intake.id = ${intakeId}
        AND intake.intake_version = ${SUBMISSION_INTAKE_VERSION}
        AND intake.email_follow_up_consent = true
        AND intake.contact_consent_version = ${CONTACT_CONSENT_VERSION}
        AND intake.contact_retention_expires_at > pg_catalog.clock_timestamp()
        AND intake.retention_expires_at > pg_catalog.clock_timestamp()
        AND parent.status IN ('pending', 'in_review')
      LIMIT 1
    `);
    const intake = eligible[0];
    if (!intake || (event.kind === "matching_publication" && intake.kind !== "missing_part")) {
      throw new Error("SUBMISSION_FOLLOW_UP_NOT_AVAILABLE");
    }

    const queuedRows = await transaction.execute<{ followUpId: string }>(sql`
      INSERT INTO submission_email_follow_ups (
        intake_id,
        submission_id,
        follow_up_key,
        qualifying_event,
        template_key,
        available_at
      ) VALUES (
        ${intakeId},
        ${intake.submissionId},
        ${followUpKey},
        ${event.kind},
        ${templateKey},
        pg_catalog.clock_timestamp()
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
        eq(submissionEmailFollowUps.intakeId, intakeId),
        eq(submissionEmailFollowUps.submissionId, intake.submissionId),
        eq(submissionEmailFollowUps.templateKey, templateKey),
      ))
      .limit(1);
    if (!existing) throw new Error("SUBMISSION_FOLLOW_UP_NOT_AVAILABLE");
    return Object.freeze({ duplicate: true, followUpId: existing.followUpId });
  });
}

export async function cleanupExpiredAnonymousSubmissions(
  database: Database,
  limit = 100,
): Promise<Readonly<{
  deletedContacts: number;
  deletedFollowUps: number;
  deletedIntakes: number;
  deletedSubmissions: number;
}>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("SUBMISSION_RETENTION_CLEANUP_INVALID");
  }
  const rows = await database.execute<{
    deletedContacts: number;
    deletedFollowUps: number;
    deletedIntakes: number;
    deletedSubmissions: number;
  }>(sql`
    SELECT
      deleted_contacts::int AS "deletedContacts",
      deleted_follow_ups::int AS "deletedFollowUps",
      deleted_intakes::int AS "deletedIntakes",
      deleted_submissions::int AS "deletedSubmissions"
    FROM public.cleanup_expired_submission_intakes(${limit})
  `);
  const result = rows[0];
  if (!result) throw new Error("SUBMISSION_RETENTION_CLEANUP_FAILED");
  return Object.freeze(result);
}

function followUpTemplate(event: SubmissionFollowUpEvent): string {
  if (event.kind !== "matching_publication" && event.kind !== "moderator_question") {
    throw new Error("SUBMISSION_FOLLOW_UP_EVENT_INVALID");
  }
  return event.kind === "matching_publication" ? "missing-part-match-alert" : "moderator-follow-up";
}

function canonicalSubmissionFollowUpEventId(value: string): string {
  try {
    const canonical = stringifyUuid(parseUuid(value));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(canonical)) {
      throw new TypeError("Unsupported UUID version");
    }
    return canonical;
  } catch {
    throw new Error("SUBMISSION_FOLLOW_UP_EVENT_INVALID");
  }
}

export async function consumeSubmissionRateLimitBuckets(
  buckets: readonly SubmissionRateBucket[],
  now = new Date(),
  database: Database,
): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
  return database.transaction(async (transaction) => {
    await lockAndVerifySubmissionHmacKeyPin(transaction);
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
