import { spawnSync } from "node:child_process";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { resolveRedirectChain } from "../src/domain/catalogue";
import { commitCandidateImport, prepareCandidateImport, queueCandidateImportReview } from "../src/db/imports";
import {
  archiveFitment,
  createCatalogTargetDraft,
  getSubmissionEvidenceLink,
  listEditorialQueue,
  moderateEvidence,
  prepareCreatorSubmission,
  publishCreatorSubmission,
  reviewCreatorSubmission,
} from "../src/db/editorial";
import { loadImportPack } from "./load-import-pack";
import { seedDatabase, seedIds } from "./seed-data";
import * as schema from "../src/db/schema";

const seededTables = [
  "brands",
  "categories",
  "components",
  "creators",
  "design_revisions",
  "designs",
  "fitment_evidence",
  "fitments",
  "product_components",
  "product_identifiers",
  "product_models",
  "safety_reviews",
  "source_platform_policies",
  "sources",
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_TEST_URL is required for the destructive fresh-database check.");
  }

  assertSafeTestDatabaseUrl(databaseUrl, process.env.CI === "true");

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  const database = drizzle(sql, { schema });

  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await sql.unsafe('CREATE SCHEMA "public"');
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          EXECUTE 'CREATE ROLE anon NOLOGIN';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          EXECUTE 'CREATE ROLE authenticated NOLOGIN';
        END IF;
      END;
      $$
    `;
    await migrate(database, { migrationsFolder: "drizzle" });
    await migrate(database, { migrationsFolder: "drizzle" });

    const tableRows = await sql<{ tableCount: number }[]>`
      SELECT count(*)::int AS "tableCount"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tableCount = tableRows[0]?.tableCount;
    if (tableCount !== 28) throw new Error(`Expected 28 public tables after migration, found ${tableCount}.`);
    const [enumInventory] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND type.typtype = 'e'
    `;
    if (enumInventory?.count !== 16) throw new Error(`Expected 16 public enums after migration, found ${enumInventory?.count}.`);

    const submissionRepository = await import("../src/db/submissions");
    for (const variable of [
      "MAILGUN_API_KEY",
      "POSTMARK_SERVER_TOKEN",
      "RESEND_API_KEY",
      "SENDGRID_API_KEY",
      "SMTP_URL",
    ]) delete process.env[variable];
    const consentedAt = new Date("2026-07-12T12:00:00.000Z");
    const contactRetentionExpiresAt = new Date("2026-08-11T12:00:00.000Z");
    const retentionExpiresAt = new Date("2026-10-10T12:00:00.000Z");
    let incompleteConsentRejected = false;
    try {
      await database.insert(schema.submissions).values({
        intakeVersion: 1,
        kind: "missing_part",
        payload: { brand: "Constraint fixture" },
        status: "pending",
      });
    } catch (error) {
      incompleteConsentRejected = hasDatabaseErrorCode(error, "23514");
    }
    if (!incompleteConsentRejected) throw new Error("Version-one submissions must satisfy the complete consent and anti-spam contract.");

    const baseSubmission = {
      challengeVerifiedAt: consentedAt,
      consentedAt,
      contactEmail: "private-wp08@example.invalid",
      contentFingerprint: "content-a".padEnd(64, "0"),
      contributorKey: "contributor-a".padEnd(64, "0"),
      idempotencyKeyHash: "idempotency-a".padEnd(64, "0"),
      kind: "missing_part" as const,
      payload: {
        brand: "WP08 private fixture",
        brokenPart: "Latch",
        modelNumber: "PRIVATE-100",
        notes: "Database-only fixture",
        oemPartNumber: "",
      },
      contactRetentionExpiresAt,
      retentionExpiresAt,
      retentionPolicyVersion: "wp08-database-fixture-v1",
      requestFingerprint: "request-a".padEnd(64, "0"),
    };
    const createdSubmission = await submissionRepository.persistAnonymousSubmission(baseSubmission, database);
    const retriedSubmission = await submissionRepository.persistAnonymousSubmission(baseSubmission, database);
    if (
      createdSubmission.duplicate
      || !retriedSubmission.duplicate
      || createdSubmission.id !== retriedSubmission.id
      || createdSubmission.receiptId !== retriedSubmission.receiptId
      || createdSubmission.receiptId === createdSubmission.id
    ) {
      throw new Error("Idempotent submission retry did not resolve to one private queue row.");
    }

    const contentDuplicate = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      idempotencyKeyHash: "idempotency-b".padEnd(64, "0"),
    }, database);
    if (!contentDuplicate.duplicate || contentDuplicate.id !== createdSubmission.id) {
      throw new Error("Same-contributor active content was not deduplicated atomically.");
    }

    const independentSubmission = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactEmail: undefined,
      contributorKey: "contributor-b".padEnd(64, "0"),
      idempotencyKeyHash: "idempotency-c".padEnd(64, "0"),
      requestFingerprint: "request-independent".padEnd(64, "0"),
    }, database);
    if (independentSubmission.duplicate || independentSubmission.id === createdSubmission.id) {
      throw new Error("An independent contributor's evidence was incorrectly collapsed by content deduplication.");
    }

    const contributorScopedIdempotency = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contributorKey: "contributor-c".padEnd(64, "0"),
      requestFingerprint: "request-scoped-idempotency".padEnd(64, "0"),
    }, database);
    if (
      contributorScopedIdempotency.duplicate
      || contributorScopedIdempotency.id === createdSubmission.id
      || contributorScopedIdempotency.receiptId === createdSubmission.receiptId
    ) {
      throw new Error("A different contributor collided with another contributor's idempotency key.");
    }

    let reusedKeyRejected = false;
    try {
      await submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contentFingerprint: "different-content".padEnd(64, "0"),
        payload: { ...baseSubmission.payload, brokenPart: "Different component" },
        requestFingerprint: "request-different".padEnd(64, "0"),
      }, database);
    } catch (error) {
      reusedKeyRejected = error instanceof Error && error.name === "SubmissionIdempotencyConflictError";
    }
    if (!reusedKeyRejected) throw new Error("An idempotency key reused for different content was not rejected.");

    let sameContributorChangedContactRejected = false;
    try {
      await submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contactEmail: "changed-contact-same-contributor@example.invalid",
        requestFingerprint: "request-changed-contact-same-contributor".padEnd(64, "0"),
      }, database);
    } catch (error) {
      sameContributorChangedContactRejected = error instanceof Error
        && error.name === "SubmissionIdempotencyConflictError";
    }
    if (!sameContributorChangedContactRejected) {
      throw new Error("The same contributor reused an idempotency key with changed contact semantics.");
    }

    const changedContributorContact = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactEmail: "different-private@example.invalid",
      contributorKey: "different-contact-contributor".padEnd(64, "0"),
      requestFingerprint: "request-different-contact".padEnd(64, "0"),
    }, database);
    if (changedContributorContact.duplicate || changedContributorContact.id === createdSubmission.id) {
      throw new Error("A different contributor collided through another contributor's idempotency key.");
    }
    const originalContacts = await sql<{ contactEmail: string; followUps: number }[]>`
      SELECT contact_email AS "contactEmail",
        (SELECT count(*)::int FROM submission_email_follow_ups WHERE submission_id = submissions.id) AS "followUps"
      FROM submissions WHERE id IN (${createdSubmission.id}, ${changedContributorContact.id})
      ORDER BY contact_email
    `;
    if (
      originalContacts.length !== 2
      || originalContacts.some((row) => row.followUps !== 0)
      || !originalContacts.some((row) => row.contactEmail === baseSubmission.contactEmail)
      || !originalContacts.some((row) => row.contactEmail === "different-private@example.invalid")
    ) {
      throw new Error("Contributor-scoped idempotency overwrote private contact or created email work during intake.");
    }

    const outcomeSubmissions = await Promise.all([
      submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contentFingerprint: "print-failed".padEnd(64, "0"),
        contributorKey: "outcome-reporter".padEnd(64, "0"),
        idempotencyKeyHash: "idempotency-print".padEnd(64, "0"),
        kind: "fit_confirmation",
        payload: {
          designRevision: "r2",
          modelNumber: "PRIVATE-100",
          outcome: "print_failed",
          partSlug: "private-latch-r2",
          evidenceUrl: "https://example.invalid/private-fit-evidence?token=WP08_PRIVATE_EVIDENCE_SENTINEL",
        },
        requestFingerprint: "request-print".padEnd(64, "0"),
      }, database),
      submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contactEmail: undefined,
        contentFingerprint: "does-not-fit".padEnd(64, "0"),
        contributorKey: "outcome-reporter".padEnd(64, "0"),
        idempotencyKeyHash: "idempotency-no-fit".padEnd(64, "0"),
        kind: "fit_confirmation",
        payload: {
          designRevision: "r2",
          modelNumber: "PRIVATE-100",
          outcome: "does_not_fit",
          partSlug: "private-latch-r2",
        },
        requestFingerprint: "request-no-fit".padEnd(64, "0"),
      }, database),
    ]);
    if (outcomeSubmissions.some((submission) => submission.duplicate)) {
      throw new Error("Distinct print_failed and does_not_fit reports were deduplicated together.");
    }

    const privateQueue = await listEditorialQueue(database);
    const groupedDemand = privateQueue.submissions.filter((submission) =>
      submission.kind === "missing_part" && submission.payload.modelNumber === "PRIVATE-100");
    if (groupedDemand.length !== 4 || groupedDemand.some((submission) => submission.demandCount !== 4)) {
      throw new Error("Private missing-part demand did not expose a distinct-contributor group count.");
    }
    const serializedQueue = JSON.stringify(privateQueue);
    if (serializedQueue.includes("private-wp08@example.invalid")
      || serializedQueue.includes(baseSubmission.contributorKey)
      || serializedQueue.includes(baseSubmission.idempotencyKeyHash)) {
      throw new Error("Editorial queue response exposed private contact or pseudonymous control keys.");
    }
    if (serializedQueue.includes("WP08_PRIVATE_EVIDENCE_SENTINEL")) {
      throw new Error("General AAL1 editorial queue exposed a private submitted evidence URL.");
    }
    const protectedEvidence = await getSubmissionEvidenceLink(database, outcomeSubmissions[0]!.id);
    if (!protectedEvidence.evidenceUrl.includes("WP08_PRIVATE_EVIDENCE_SENTINEL")) {
      throw new Error("AAL2 evidence-review lookup could not retrieve the submitted private evidence link.");
    }

    const [privateQueueEvidence] = await sql<{
      controlFields: number;
      nonPending: number;
      outboxEvents: number;
      outcomeCount: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions WHERE intake_version = 1 AND payload ?| ARRAY[
          'email', 'website', 'challengeToken', 'privacyConsent', 'contributionConsent',
          'emailFollowUpConsent', 'idempotencyKey'
        ]) AS "controlFields",
        (SELECT count(*)::int FROM submissions WHERE intake_version = 1 AND status <> 'pending') AS "nonPending",
        (SELECT count(*)::int FROM submission_email_follow_ups WHERE submission_id = ${createdSubmission.id}) AS "outboxEvents",
        (SELECT count(DISTINCT payload->>'outcome')::int FROM submissions
          WHERE id IN (${outcomeSubmissions[0]!.id}, ${outcomeSubmissions[1]!.id})) AS "outcomeCount"
    `;
    if (
      privateQueueEvidence?.controlFields !== 0
      || privateQueueEvidence.nonPending !== 0
      || privateQueueEvidence.outboxEvents !== 0
      || privateQueueEvidence.outcomeCount !== 2
    ) {
      throw new Error(`Anonymous contribution privacy/outbox evidence failed: ${JSON.stringify(privateQueueEvidence)}.`);
    }

    const triggered = await submissionRepository.triggerSubmissionEmailFollowUp(
      createdSubmission.id,
      { eventId: "00000000-0000-4000-8000-000000000501", kind: "matching_publication" },
      database,
      consentedAt,
    );
    const retriggered = await submissionRepository.triggerSubmissionEmailFollowUp(
      createdSubmission.id,
      { eventId: "00000000-0000-4000-8000-000000000501", kind: "matching_publication" },
      database,
      consentedAt,
    );
    const [triggeredFollowUp] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM submission_email_follow_ups
      WHERE submission_id = ${createdSubmission.id} AND status = 'pending' AND available_at = ${consentedAt.toISOString()}
    `;
    if (
      triggered.duplicate
      || !retriggered.duplicate
      || triggered.followUpId !== retriggered.followUpId
      || triggeredFollowUp?.count !== 1
    ) {
      throw new Error("A qualifying follow-up event was not queued exactly once.");
    }
    let invalidEventIdRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        createdSubmission.id,
        { eventId: "client-chosen-label", kind: "moderator_question" },
        database,
        consentedAt,
      );
    } catch (error) {
      invalidEventIdRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_EVENT_INVALID";
    }
    let mismatchedEventRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        outcomeSubmissions[0]!.id,
        { eventId: "00000000-0000-4000-8000-000000000504", kind: "matching_publication" },
        database,
        consentedAt,
      );
    } catch (error) {
      mismatchedEventRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!invalidEventIdRejected || !mismatchedEventRejected) {
      throw new Error("Follow-up creation accepted an unqualified event ID or a kind/submission mismatch.");
    }
    await database.update(schema.submissions)
      .set({ contactConsentVersion: "obsolete-consent-version" })
      .where(eq(schema.submissions.id, changedContributorContact.id));
    let obsoleteConsentRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        changedContributorContact.id,
        { eventId: "00000000-0000-4000-8000-000000000507", kind: "moderator_question" },
        database,
        consentedAt,
      );
    } catch (error) {
      obsoleteConsentRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    await database.update(schema.submissions)
      .set({ contactConsentVersion: submissionRepository.CONTACT_CONSENT_VERSION })
      .where(eq(schema.submissions.id, changedContributorContact.id));
    if (!obsoleteConsentRejected) throw new Error("An obsolete contact-consent version scheduled email work.");

    const concurrencyClient = postgres(databaseUrl, { prepare: false, max: 8 });
    const concurrencyDatabase = drizzle(concurrencyClient, { schema });
    try {
      const concurrentResults = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: "concurrent-private@example.invalid",
          contentFingerprint: "concurrent-content".padEnd(64, "0"),
          contributorKey: "concurrent-contributor".padEnd(64, "0"),
          idempotencyKeyHash: `concurrent-${index}`.padEnd(64, "0"),
          requestFingerprint: "concurrent-request".padEnd(64, "0"),
        }, concurrencyDatabase)));
      if (new Set(concurrentResults.map((result) => result.id)).size !== 1
        || new Set(concurrentResults.map((result) => result.receiptId)).size !== 1
        || concurrentResults.filter((result) => !result.duplicate).length !== 1) {
        throw new Error("Concurrent same-contributor duplicates created more than one active queue row.");
      }
      const [concurrentPersistence] = await sql<{ followUps: number; submissions: number }[]>`
        SELECT
          (SELECT count(*)::int FROM submissions
            WHERE contributor_key = ${"concurrent-contributor".padEnd(64, "0")}
              AND content_fingerprint = ${"concurrent-content".padEnd(64, "0")}) AS submissions,
          (SELECT count(*)::int FROM submission_email_follow_ups
            WHERE submission_id = ${concurrentResults[0]!.id}) AS "followUps"
      `;
      if (concurrentPersistence?.submissions !== 1 || concurrentPersistence.followUps !== 0) {
        throw new Error("Concurrent deduplication did not commit exactly one submission without email work.");
      }

      const concurrentIdempotentResults = await Promise.all(Array.from({ length: 8 }, () =>
        submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: undefined,
          contactRetentionExpiresAt: undefined,
          contentFingerprint: "concurrent-key-content".padEnd(64, "0"),
          contributorKey: "concurrent-key-contributor".padEnd(64, "0"),
          idempotencyKeyHash: "concurrent-same-idempotency".padEnd(64, "0"),
          requestFingerprint: "concurrent-same-request".padEnd(64, "0"),
        }, concurrencyDatabase)));
      if (
        new Set(concurrentIdempotentResults.map((result) => result.id)).size !== 1
        || new Set(concurrentIdempotentResults.map((result) => result.receiptId)).size !== 1
        || concurrentIdempotentResults.filter((result) => !result.duplicate).length !== 1
      ) {
        throw new Error("Concurrent identical idempotency retries did not return one stable receipt.");
      }

      const windowStartedAt = new Date("2026-07-12T12:00:00.000Z");
      const rateBucket = Object.freeze({
        expiresAt: new Date("2026-07-14T12:00:00.000Z"),
        limit: 3,
        scope: "wp08-concurrency-fixture",
        subjectHash: "rate-subject-hash-without-raw-ip",
        windowSeconds: 600,
        windowStartedAt,
      });
      const rateResults = await Promise.all(Array.from({ length: 8 }, () =>
        submissionRepository.consumeSubmissionRateLimitBuckets([rateBucket], consentedAt, concurrencyDatabase)));
      if (rateResults.filter((result) => result.allowed).length !== 3
        || rateResults.filter((result) => !result.allowed).length !== 5) {
        throw new Error("Atomic rate limiting did not admit exactly the configured concurrent limit.");
      }
      const [storedRateBucket] = await sql<{ requestCount: number; rawIpRows: number }[]>`
        SELECT request_count AS "requestCount",
          (SELECT count(*)::int FROM submission_rate_limit_buckets WHERE subject_hash LIKE '%203.0.113.%') AS "rawIpRows"
        FROM submission_rate_limit_buckets
        WHERE scope = 'wp08-concurrency-fixture'
      `;
      if (storedRateBucket?.requestCount !== 3 || storedRateBucket.rawIpRows !== 0) {
        throw new Error("Rate bucket count overshot its limit or retained a raw network address.");
      }

      const rollbackIdempotency = "rollback-idempotency".padEnd(64, "0");
      let retentionRollbackObserved = false;
      try {
        await submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: "rollback-private@example.invalid",
          contentFingerprint: "rollback-content".padEnd(64, "0"),
          contributorKey: "rollback-contributor".padEnd(64, "0"),
          idempotencyKeyHash: rollbackIdempotency,
          retentionExpiresAt: consentedAt,
          requestFingerprint: "rollback-request".padEnd(64, "0"),
        }, concurrencyDatabase);
      } catch {
        retentionRollbackObserved = true;
      }
      const [rolledBackSubmission] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM submissions WHERE idempotency_key_hash = ${rollbackIdempotency}
      `;
      if (!retentionRollbackObserved || rolledBackSubmission?.count !== 0) {
        throw new Error("An invalid retention contract did not fail closed without a private submission.");
      }
    } finally {
      await concurrencyClient.end();
    }

    await database.update(schema.submissions)
      .set({ resolvedAt: consentedAt, status: "resolved" })
      .where(eq(schema.submissions.id, createdSubmission.id));
    let resolvedFollowUpRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        createdSubmission.id,
        { eventId: "00000000-0000-4000-8000-000000000505", kind: "moderator_question" },
        database,
        consentedAt,
      );
    } catch (error) {
      resolvedFollowUpRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!resolvedFollowUpRejected) throw new Error("A resolved submission scheduled new email work.");
    const postResolution = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      idempotencyKeyHash: "idempotency-after-resolution".padEnd(64, "0"),
    }, database);
    if (postResolution.duplicate) throw new Error("Resolved content incorrectly blocked a new active contribution.");

    const cleanupConsentedAt = new Date("2026-01-01T00:00:00.000Z");
    const fullyExpired = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      consentedAt: cleanupConsentedAt,
      challengeVerifiedAt: cleanupConsentedAt,
      contactEmail: "cleanup-delete@example.invalid",
      contactRetentionExpiresAt: new Date("2026-01-03T00:00:00.000Z"),
      contentFingerprint: "cleanup-delete-content".padEnd(64, "0"),
      contributorKey: "cleanup-delete-contributor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-delete-idempotency".padEnd(64, "0"),
      requestFingerprint: "cleanup-delete-request".padEnd(64, "0"),
      retentionExpiresAt: new Date("2026-01-04T00:00:00.000Z"),
    }, database);
    const contactExpired = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      consentedAt: cleanupConsentedAt,
      challengeVerifiedAt: cleanupConsentedAt,
      contactEmail: "cleanup-redact@example.invalid",
      contactRetentionExpiresAt: new Date("2026-01-05T00:00:00.000Z"),
      contentFingerprint: "cleanup-redact-content".padEnd(64, "0"),
      contributorKey: "cleanup-redact-contributor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-redact-idempotency".padEnd(64, "0"),
      requestFingerprint: "cleanup-redact-request".padEnd(64, "0"),
      retentionExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
    }, database);
    await submissionRepository.triggerSubmissionEmailFollowUp(
      fullyExpired.id,
      { eventId: "00000000-0000-4000-8000-000000000502", kind: "moderator_question" },
      database,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    await submissionRepository.triggerSubmissionEmailFollowUp(
      contactExpired.id,
      { eventId: "00000000-0000-4000-8000-000000000503", kind: "moderator_question" },
      database,
      new Date("2026-01-02T00:00:00.000Z"),
    );

    const cleanupNow = new Date("2026-01-06T00:00:00.000Z");
    const firstCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, cleanupNow, 1);
    const secondCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, cleanupNow, 1);
    const repeatedCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, cleanupNow, 1);
    if (
      firstCleanup.deletedSubmissions !== 1
      || firstCleanup.redactedContacts !== 0
      || secondCleanup.deletedSubmissions !== 0
      || secondCleanup.redactedContacts !== 1
      || repeatedCleanup.deletedSubmissions !== 0
      || repeatedCleanup.redactedContacts !== 0
    ) {
      throw new Error("Bounded retention cleanup was not ordered, complete, and idempotent.");
    }
    const [cleanupEvidence] = await sql<{
      deletedFollowUps: number;
      deletedSubmissions: number;
      redactedContact: string | null;
      redactedConsent: string | null;
      redactedFollowUps: number;
      redactedContributor: string;
      redactedRequest: string;
      receiptId: string;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submission_email_follow_ups WHERE submission_id = ${fullyExpired.id}) AS "deletedFollowUps",
        (SELECT count(*)::int FROM submissions WHERE id = ${fullyExpired.id}) AS "deletedSubmissions",
        contact_email AS "redactedContact",
        contact_consent_version AS "redactedConsent",
        (SELECT count(*)::int FROM submission_email_follow_ups WHERE submission_id = ${contactExpired.id}) AS "redactedFollowUps",
        contributor_key AS "redactedContributor",
        request_fingerprint AS "redactedRequest",
        receipt_id AS "receiptId"
      FROM submissions WHERE id = ${contactExpired.id}
    `;
    if (
      !cleanupEvidence
      || cleanupEvidence.deletedFollowUps !== 0
      || cleanupEvidence.deletedSubmissions !== 0
      || cleanupEvidence.redactedContact !== null
      || cleanupEvidence.redactedConsent !== null
      || cleanupEvidence.redactedFollowUps !== 0
      || cleanupEvidence.redactedContributor === "cleanup-redact-contributor".padEnd(64, "0")
      || cleanupEvidence.redactedRequest === "cleanup-redact-request".padEnd(64, "0")
      || cleanupEvidence.receiptId !== contactExpired.receiptId
    ) {
      throw new Error(`Retention cleanup left private contact or derived identifiers: ${JSON.stringify(cleanupEvidence)}.`);
    }
    let expiredConsentRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        contactExpired.id,
        { eventId: "00000000-0000-4000-8000-000000000506", kind: "moderator_question" },
        database,
        cleanupNow,
      );
    } catch (error) {
      expiredConsentRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!expiredConsentRejected) throw new Error("Expired/redacted contact consent scheduled new email work.");

    await database.delete(schema.submissionEmailFollowUps);
    await database.delete(schema.submissionRateLimitBuckets);
    await database.delete(schema.submissions);

    const viewRows = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name LIKE 'published_%'
    `;
    if (viewRows[0]?.viewCount !== 4) throw new Error("Expected four published-only anonymous views.");

    const searchViewRows = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM pg_matviews
      WHERE schemaname = 'public' AND matviewname = 'public_search_documents'
    `;
    if (searchViewRows[0]?.viewCount !== 1) throw new Error("Expected the denormalized public search view.");

    const [catalogueViews] = await sql<{ viewCount: number }[]>`
      SELECT count(*)::int AS "viewCount"
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('public_catalogue_fitments', 'public_catalogue_unavailable_sources')
    `;
    if (catalogueViews?.viewCount !== 2) throw new Error("Expected both production public catalogue views.");
    const [unsafeUnavailableColumns] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'public_catalogue_unavailable_sources'
        AND column_name IN (
          'source_url', 'payload', 'email', 'contact_email', 'contributor_key',
          'idempotency_key_hash', 'request_fingerprint', 'content_fingerprint',
          'challenge_provider', 'challenge_verified_at', 'supporting_excerpt'
        )
    `;
    if (unsafeUnavailableColumns?.count !== 0) {
      throw new Error("Unavailable-source tombstones expose a removed URL or private payload column.");
    }
    const catalogueColumnNames = await sql<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'public_catalogue_fitments'
      ORDER BY ordinal_position
    `;
    const forbiddenCatalogueColumns = [
      "payload",
      "email",
      "contact_email",
      "contributor_key",
      "idempotency_key_hash",
      "request_fingerprint",
      "content_fingerprint",
      "challenge_provider",
      "challenge_verified_at",
      "notes",
      "moderation_status",
      "supporting_excerpt",
      "source_citation_id",
    ];
    if (catalogueColumnNames.some(({ columnName }) => forbiddenCatalogueColumns.includes(columnName))) {
      throw new Error("Published catalogue view exposes a private or moderation-only column.");
    }
    for (const role of ["anon", "authenticated"] as const) {
      await sql.unsafe(`SET ROLE "${role}"`);
      try {
        await sql`SELECT count(*) FROM public_catalogue_fitments`;
        await sql`SELECT count(*) FROM public_catalogue_unavailable_sources`;
        await sql`SELECT count(*) FROM public_search_documents`;
        const [unsafeBasePrivileges] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_class AS relation
          INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p')
            AND has_table_privilege(current_user, format('%I.%I', namespace.nspname, relation.relname), 'SELECT')
        `;
        if (unsafeBasePrivileges?.count !== 0) {
          throw new Error(`${role} retained SELECT on ${unsafeBasePrivileges?.count ?? "unknown"} public base tables.`);
        }
        const [unsafeLegacyViewPrivileges] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM (VALUES
            ('published_brands'),
            ('published_designs'),
            ('published_fitments'),
            ('published_product_models')
          ) AS legacy_view(view_name)
          WHERE has_table_privilege(current_user, format('public.%I', legacy_view.view_name), 'SELECT')
        `;
        if (unsafeLegacyViewPrivileges?.count !== 0) {
          throw new Error(`${role} could bypass WP-07 eligibility through a legacy broad-row view.`);
        }
        let baseReadDenied = false;
        try {
          await sql`SELECT count(*) FROM submissions`;
        } catch (error) {
          baseReadDenied = error instanceof Error && "code" in error && error.code === "42501";
        }
        if (!baseReadDenied) throw new Error(`${role} could read the private submissions base table.`);
        const [anonymousWriteBoundary] = await sql<{
          canReadFollowUps: boolean;
          canReadRateLimits: boolean;
          canWriteFollowUps: boolean;
          canWriteRateLimits: boolean;
          canWriteSubmissions: boolean;
        }[]>`
          SELECT
            has_table_privilege(current_user, 'public.submission_email_follow_ups', 'SELECT') AS "canReadFollowUps",
            has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'SELECT') AS "canReadRateLimits",
            has_table_privilege(current_user, 'public.submission_email_follow_ups', 'INSERT,UPDATE,DELETE') AS "canWriteFollowUps",
            has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'INSERT,UPDATE,DELETE') AS "canWriteRateLimits",
            has_table_privilege(current_user, 'public.submissions', 'INSERT,UPDATE,DELETE') AS "canWriteSubmissions"
        `;
        if (anonymousWriteBoundary && Object.values(anonymousWriteBoundary).some(Boolean)) {
          throw new Error(`${role} can bypass the server-only anonymous contribution boundary.`);
        }
      } finally {
        await sql`RESET ROLE`;
      }
    }

    await sql.unsafe('SET ROLE "repairprint_submission_service"');
    try {
      const [submissionServiceBoundary] = await sql<{
        currentUser: string;
        forbiddenMutationColumns: number;
        forbiddenTablePrivileges: number;
        grantedColumnMutations: number;
        grantedTablePrivileges: number;
        hasSchemaUsage: boolean;
        leastPrivileged: boolean;
        unexpectedAllowedTablePrivileges: number;
      }[]>`
        SELECT
          current_user AS "currentUser",
          has_schema_privilege(current_user, 'public', 'USAGE') AS "hasSchemaUsage",
          (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
            FROM pg_roles WHERE rolname = current_user) AS "leastPrivileged",
          (SELECT count(*)::int
            FROM information_schema.table_privileges
            WHERE grantee = current_user
              AND table_schema = 'public'
              AND table_name IN ('submissions', 'submission_rate_limit_buckets', 'submission_email_follow_ups')
              AND privilege_type IN ('SELECT', 'DELETE')) AS "grantedTablePrivileges",
          (SELECT count(*)::int
            FROM information_schema.column_privileges
            WHERE grantee = current_user
              AND table_schema = 'public'
              AND privilege_type IN ('INSERT', 'UPDATE')) AS "grantedColumnMutations",
          (SELECT count(*)::int
            FROM (VALUES
              ('submissions', 'status', 'INSERT'),
              ('submissions', 'status', 'UPDATE'),
              ('submissions', 'payload', 'UPDATE'),
              ('submissions', 'reviewed_by', 'UPDATE'),
              ('submission_email_follow_ups', 'status', 'UPDATE'),
              ('submission_email_follow_ups', 'provider_message_id', 'UPDATE')
            ) AS forbidden(relation_name, column_name, privilege_name)
            WHERE has_column_privilege(
              current_user,
              format('public.%I', forbidden.relation_name),
              forbidden.column_name,
              forbidden.privilege_name
            )) AS "forbiddenMutationColumns",
          (SELECT count(*)::int
            FROM information_schema.table_privileges
            WHERE grantee = current_user
              AND table_schema = 'public'
              AND table_name NOT IN ('submissions', 'submission_rate_limit_buckets', 'submission_email_follow_ups')) AS "forbiddenTablePrivileges"
          ,(SELECT count(*)::int
            FROM information_schema.table_privileges
            WHERE grantee = current_user
              AND table_schema = 'public'
              AND table_name IN ('submissions', 'submission_rate_limit_buckets', 'submission_email_follow_ups')
              AND privilege_type NOT IN ('SELECT', 'DELETE')) AS "unexpectedAllowedTablePrivileges"
      `;
      if (
        submissionServiceBoundary?.currentUser !== "repairprint_submission_service"
        || !submissionServiceBoundary.hasSchemaUsage
        || !submissionServiceBoundary.leastPrivileged
        || submissionServiceBoundary.grantedTablePrivileges !== 6
        || submissionServiceBoundary.grantedColumnMutations !== 37
        || submissionServiceBoundary.forbiddenMutationColumns !== 0
        || submissionServiceBoundary.unexpectedAllowedTablePrivileges !== 0
        || submissionServiceBoundary.forbiddenTablePrivileges !== 0
      ) {
        throw new Error(`Submission service privilege allowlist is invalid: ${JSON.stringify(submissionServiceBoundary)}.`);
      }
      await sql`SELECT count(*) FROM submissions`;
      await sql`SELECT count(*) FROM submission_rate_limit_buckets`;
      await sql`SELECT count(*) FROM submission_email_follow_ups`;
      const serviceConsentAt = new Date("2026-03-01T00:00:00.000Z");
      const serviceSubmission = await submissionRepository.persistAnonymousSubmission({
        challengeVerifiedAt: serviceConsentAt,
        consentedAt: serviceConsentAt,
        contactEmail: "service-role-private@example.invalid",
        contactRetentionExpiresAt: new Date("2026-03-02T00:00:00.000Z"),
        contentFingerprint: "service-role-content".padEnd(64, "0"),
        contributorKey: "service-role-contributor".padEnd(64, "0"),
        idempotencyKeyHash: "service-role-idempotency".padEnd(64, "0"),
        kind: "missing_part",
        payload: { brand: "Service role fixture", brokenPart: "Latch", modelNumber: "SR-100" },
        requestFingerprint: "service-role-request".padEnd(64, "0"),
        retentionExpiresAt: new Date("2026-03-03T00:00:00.000Z"),
        retentionPolicyVersion: "wp08-service-role-fixture-v1",
      }, database);
      await submissionRepository.triggerSubmissionEmailFollowUp(
        serviceSubmission.id,
        { eventId: "00000000-0000-4000-8000-000000000508", kind: "moderator_question" },
        database,
        new Date("2026-03-01T12:00:00.000Z"),
      );
      const serviceRate = await submissionRepository.consumeSubmissionRateLimitBuckets([{
        expiresAt: new Date("2026-03-05T00:00:00.000Z"),
        limit: 2,
        scope: "wp08-service-role-fixture",
        subjectHash: "service-role-rate-subject".padEnd(64, "0"),
        windowSeconds: 600,
        windowStartedAt: serviceConsentAt,
      }], serviceConsentAt, database);
      const serviceCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(
        database,
        new Date("2026-03-04T00:00:00.000Z"),
        1,
      );
      if (
        !serviceRate.allowed
        || serviceCleanup.deletedSubmissions !== 1
        || serviceCleanup.redactedContacts !== 0
      ) {
        throw new Error("Dedicated submission role could not execute its bounded persistence/event/cleanup paths.");
      }
      await database.delete(schema.submissionRateLimitBuckets)
        .where(eq(schema.submissionRateLimitBuckets.scope, "wp08-service-role-fixture"));
      let unrelatedBaseDenied = false;
      try {
        await sql`SELECT count(*) FROM staff_profiles`;
      } catch (error) {
        unrelatedBaseDenied = error instanceof Error && "code" in error && error.code === "42501";
      }
      let publicViewDenied = false;
      try {
        await sql`SELECT count(*) FROM public_catalogue_fitments`;
      } catch (error) {
        publicViewDenied = error instanceof Error && "code" in error && error.code === "42501";
      }
      if (!unrelatedBaseDenied || !publicViewDenied) {
        throw new Error("Submission service role can read outside its three-table private allowlist.");
      }
    } finally {
      await sql`RESET ROLE`;
    }

    const extensionRows = await sql<{ extensionCount: number }[]>`
      SELECT count(*)::int AS "extensionCount" FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    const extensionCount = extensionRows[0]?.extensionCount;
    if (extensionCount !== 1) throw new Error("pg_trgm extension was not installed by the migration.");

    await seedDatabase(database);
    await seedDatabase(database);

    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [draftSearchDocuments] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents
    `;
    if (draftSearchDocuments?.count !== 0) {
      throw new Error("Draft models and fitments must not appear in the public search view.");
    }
    const [draftCatalogueDocuments] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments
    `;
    if (draftCatalogueDocuments?.count !== 0) {
      throw new Error("Draft models and fitments must not appear in the production catalogue view.");
    }

    for (const table of seededTables) {
      const rowCountRows = await sql.unsafe<{ rowCount: number }[]>(
        `SELECT count(*)::int AS "rowCount" FROM "${table}"`,
      );
      const rowCount = rowCountRows[0]?.rowCount;
      if (rowCount !== 1) throw new Error(`Expected one idempotent seed row in ${table}, found ${rowCount}.`);
    }

    const publishedRows = await sql<{ publishedCount: number }[]>`
      SELECT count(*)::int AS "publishedCount" FROM fitments WHERE publication_status = 'published'
    `;
    const publishedCount = publishedRows[0]?.publishedCount;
    if (publishedCount !== 0) throw new Error("The fictional seed must not publish a fitment.");

    const [staff] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000101', 'reviewer@example.invalid', 'reviewer', 'active', true)
      RETURNING id
    `;
    if (!staff) throw new Error("Staff profile fixture was not created.");

    const importFiles = loadImportPack("data/fixtures/phase0-demo");
    const dryRun = await prepareCandidateImport(database, importFiles);
    if (!dryRun.canCommit || dryRun.counts.insert !== 20) {
      throw new Error(`Expected the fictional Phase 0 dry run to accept 20 candidate rows: ${JSON.stringify(dryRun.errors)}`);
    }
    const firstImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture.",
      requestId: "req_import_gate_first",
    });
    const secondImport = await commitCandidateImport(database, {
      files: importFiles,
      expectedInputChecksum: dryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database idempotency fixture rerun.",
      requestId: "req_import_gate_second",
    });
    if (firstImport.reused || !secondImport.reused || secondImport.runId !== firstImport.runId) {
      throw new Error("Repeated Phase 0 commit did not reuse the original import run.");
    }
    const [importCounts] = await sql<{ runs: number; rows: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs) AS runs,
        (SELECT count(*)::int FROM import_rows) AS rows
    `;
    if (importCounts?.runs !== 1 || importCounts.rows !== 20) {
      throw new Error(`Expected one import run and 20 candidate rows, found ${JSON.stringify(importCounts)}.`);
    }

    const ambiguousFiles = { ...importFiles };
    ambiguousFiles["product_identifiers.csv"] = ambiguousFiles["product_identifiers.csv"].replace(
      "DV-201-B,DV-201-B,DV201B",
      "DV201A,DV201A,DV201A",
    );
    const ambiguousDryRun = await prepareCandidateImport(database, ambiguousFiles);
    if (ambiguousDryRun.canCommit || !ambiguousDryRun.errors.some((entry) => entry.code === "MODEL_AMBIGUOUS")) {
      throw new Error("Ambiguous model collision did not block commit with MODEL_AMBIGUOUS.");
    }
    const queued = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture.",
      requestId: "req_import_collision_gate",
    });
    const queuedAgain = await queueCandidateImportReview(database, {
      files: ambiguousFiles,
      expectedInputChecksum: ambiguousDryRun.inputChecksum,
      actorId: staff.id,
      reason: "Fresh database collision queue fixture rerun.",
      requestId: "req_import_collision_gate_rerun",
    });
    if (queued.reused || !queuedAgain.reused || queuedAgain.runId !== queued.runId) {
      throw new Error("Repeated collision queue write did not reuse the original failed import run.");
    }
    const [collisionCounts] = await sql<{ failedRuns: number; collisions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM import_runs WHERE status = 'failed') AS "failedRuns",
        (SELECT count(*)::int FROM import_collisions WHERE status = 'open') AS collisions
    `;
    if (collisionCounts?.failedRuns !== 1 || collisionCounts.collisions < 1) {
      throw new Error(`Expected one failed run with an open collision, found ${JSON.stringify(collisionCounts)}.`);
    }

    const [editor] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000102', 'editor@example.invalid', 'editor', 'active', false)
      RETURNING id
    `;
    const [admin] = await sql<{ id: string }[]>`
      INSERT INTO staff_profiles (auth_user_id, email, role, status, mfa_required)
      VALUES ('00000000-0000-4000-8000-000000000103', 'admin@example.invalid', 'admin', 'active', true)
      RETURNING id
    `;
    if (!editor || !admin) throw new Error("Editorial staff fixtures were not created.");
    const editorIdentity = { id: editor.id, authUserId: "00000000-0000-4000-8000-000000000102", email: "editor@example.invalid", role: "editor" as const, status: "active" as const };
    const reviewerIdentity = { id: staff.id, authUserId: "00000000-0000-4000-8000-000000000101", email: "reviewer@example.invalid", role: "reviewer" as const, status: "active" as const };
    const adminIdentity = { id: admin.id, authUserId: "00000000-0000-4000-8000-000000000103", email: "admin@example.invalid", role: "admin" as const, status: "active" as const };

    const catalogDraft = await createCatalogTargetDraft(database, editorIdentity, {
      brandId: seedIds.brand,
      categoryId: seedIds.category,
      sourceId: seedIds.source,
      sourceLocator: "Fictional manual section 4.2",
      modelPublicId: "model_demo_dv_101",
      modelName: "DV-101 Demo Region B",
      modelSlug: "demovac-dv-101-demo-region-b",
      marketCodes: ["DEMO-B"],
      identifierDisplay: "DV-101-B",
      identifierType: "model_number",
      component: { mode: "existing", id: seedIds.component },
      oem: { mode: "new", publicId: "oem_demo_latch_101b", partNumberDisplay: "DEMO-LATCH-101-B", name: "Fictional dust-bin latch B" },
      reason: "Prepare a fictional exact catalog target with source-backed pending claims.",
      requestId: "req_catalog_prepare",
    });
    const [catalogCounts] = await sql<{ modelDrafts: number; pendingMappings: number; citations: number; auditEvents: number }[]>`
      SELECT
        (SELECT count(*)::int FROM product_models WHERE id = ${catalogDraft.productModelId} AND publication_status = 'draft') AS "modelDrafts",
        (SELECT count(*)::int FROM product_components WHERE id = ${catalogDraft.productComponentId} AND mapping_status = 'pending') AS "pendingMappings",
        (SELECT count(*)::int FROM source_citations WHERE entity_id IN (${catalogDraft.productModelId}, ${catalogDraft.productComponentId})) AS citations,
        (SELECT count(*)::int FROM audit_log WHERE action = 'catalog.target.prepare' AND entity_id = ${catalogDraft.productComponentId}) AS "auditEvents"
    `;
    if (catalogCounts?.modelDrafts !== 1 || catalogCounts.pendingMappings !== 1 || catalogCounts.citations !== 2 || catalogCounts.auditEvents !== 1) {
      throw new Error(`Catalog draft editor evidence is incomplete: ${JSON.stringify(catalogCounts)}.`);
    }

    const [creatorSubmission] = await database
      .insert(schema.submissions)
      .values({
        kind: "design_submission",
        status: "pending",
        payload: {
          sourceUrl: "https://example.invalid/editorial/publishable-latch",
          creatorName: "Fictional workflow creator",
          brand: "DemoVac",
          modelNumber: "DV-100",
          componentName: "Dust-bin latch",
          claimedLicense: "NOT-STATED",
          notes: "Fictional creator-listed exact-model claim.",
          email: "",
          website: "",
        },
      })
      .returning({ id: schema.submissions.id });
    if (!creatorSubmission) throw new Error("Creator submission fixture was not created.");

    const prepared = await prepareCreatorSubmission(database, creatorSubmission.id, editorIdentity, {
      productComponentId: seedIds.productComponent,
      confirmExactTarget: true,
      designTitle: "Fictional DV-100 latch workflow fixture",
      creatorPlatform: "example.invalid",
      sourcePlatform: "example.invalid",
      sourceExternalId: "editorial-publishable-latch",
      sourceRevision: "r1",
      sourceTitle: "Fictional creator landing page",
      licenseCode: "NOT-STATED",
      licenseVersion: "",
      licenseUrl: "",
      licenseEvidenceUrl: "https://example.invalid/editorial/publishable-latch",
      attributionText: "Fictional latch by Fictional workflow creator",
      fileFormats: ["STL"],
      observedAt: "2026-07-11",
      evidenceSummary: "Creator explicitly lists the exact fictional DV-100 model and r1 revision.",
      reason: "Prepare the fictional creator submission for independent review.",
      requestId: "req_editorial_prepare",
    });

    const [catalogueClaimSource] = await database.insert(schema.sources).values({
      sourceType: "editorial_reference",
      platform: "example.invalid",
      canonicalUrl: "https://example.invalid/editorial/catalogue-target-provenance",
      title: "Fictional exact-target provenance",
      retrievedAt: new Date("2026-07-11T00:00:00Z"),
      lastCheckedAt: new Date("2026-07-12T00:00:00Z"),
      status: "live",
    }).returning({ id: schema.sources.id });
    const [primaryIdentifier] = await sql<{ id: string }[]>`
      SELECT id FROM product_identifiers WHERE product_model_id = ${seedIds.model} LIMIT 1
    `;
    if (!catalogueClaimSource || !primaryIdentifier) throw new Error("Catalogue target provenance fixtures were not created.");
    const targetClaimRows = await database.insert(schema.sourceCitations).values([
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_model",
        entityId: seedIds.model,
        fieldPath: "model_name",
        claimValue: "DV-100",
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_identifier",
        entityId: primaryIdentifier.id,
        fieldPath: "display_value",
        claimValue: "DV-100",
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_component",
        entityId: seedIds.productComponent,
        fieldPath: "mapping",
        claimValue: { productModelId: seedIds.model, componentId: seedIds.component, oemPartId: null },
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        sourceId: catalogueClaimSource.id,
        entityType: "component",
        entityId: seedIds.component,
        fieldPath: "common_names",
        claimValue: ["bin catch", "release latch"],
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ]).returning({ id: schema.sourceCitations.id, entityType: schema.sourceCitations.entityType });
    const primaryIdentifierClaim = targetClaimRows.find((row) => row.entityType === "product_identifier");
    const targetMappingClaim = targetClaimRows.find((row) => row.entityType === "product_component");
    if (!primaryIdentifierClaim || !targetMappingClaim) throw new Error("Required exact-target citations were not written.");
    await sql`UPDATE product_identifiers SET source_citation_id = ${primaryIdentifierClaim.id} WHERE id = ${primaryIdentifier.id}`;
    await sql`UPDATE product_components SET source_citation_id = ${targetMappingClaim.id} WHERE id = ${seedIds.productComponent}`;

    let selfReviewRejected = false;
    try {
      await reviewCreatorSubmission(database, creatorSubmission.id, editorIdentity, {
        decision: "accept",
        safetyClass: "low",
        safetySignals: ["low_load_clip"],
        safetyRationale: "Fictional low-load external latch.",
        reason: "Attempted self review fixture.",
        requestId: "req_editorial_self_review",
      });
    } catch (error) {
      selfReviewRejected = error instanceof Error && error.message === "SELF_REVIEW_FORBIDDEN";
    }
    if (!selfReviewRejected) throw new Error("Editor self-review was not rejected.");

    const reviewed = await reviewCreatorSubmission(database, creatorSubmission.id, reviewerIdentity, {
      decision: "accept",
      safetyClass: "low",
      safetySignals: ["low_load_clip"],
      safetyRationale: "Fictional low-load external latch; failure causes inconvenience only.",
      reason: "Independently reviewed source, rights, exact target, evidence, and safety.",
      requestId: "req_editorial_review",
    });
    if (reviewed.fitmentId !== prepared.fitmentId || reviewed.status !== "accepted") {
      throw new Error("Independent editorial review did not accept the prepared fitment.");
    }
    await publishCreatorSubmission(database, creatorSubmission.id, reviewerIdentity, {
      reason: "All deterministic publication gates passed for the fictional fixture.",
      requestId: "req_editorial_publish",
    });
    const [publishedEditorial] = await sql<{ rowCount: number }[]>`
      SELECT count(*)::int AS "rowCount" FROM published_fitments WHERE id = ${prepared.fitmentId}
    `;
    if (publishedEditorial?.rowCount !== 1) throw new Error("Reviewed editorial fitment was not exposed by the published-only view.");
    const searchDocuments = await sql<{ entityType: string; entityId: string }[]>`
      SELECT entity_type AS "entityType", entity_id AS "entityId"
      FROM public_search_documents
      ORDER BY entity_type, entity_id
    `;
    if (
      searchDocuments.length !== 2 ||
      searchDocuments[0]?.entityType !== "model" ||
      searchDocuments[1]?.entityType !== "part" ||
      searchDocuments[1]?.entityId !== prepared.fitmentId
    ) {
      throw new Error(`Published search view did not expose exactly the eligible model and fitment: ${JSON.stringify(searchDocuments)}.`);
    }
    const [publishedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_catalogue_fitments
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (publishedCatalogue?.count !== 1) {
      throw new Error("Production catalogue did not expose the independently reviewed eligible fitment.");
    }

    const [publishedGraph] = await sql<{
      designId: string;
      revisionId: string;
      sourceId: string;
      componentId: string;
      modelId: string;
      fitmentSlug: string;
    }[]>`
      SELECT
        design_id AS "designId",
        revision_id AS "revisionId",
        source_id AS "sourceId",
        component_id AS "componentId",
        model_id AS "modelId",
        fitment_slug AS "fitmentSlug"
      FROM public_catalogue_fitments
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (!publishedGraph) throw new Error("Published catalogue graph fixture was not found.");

    const [acceptedRevisionCitation] = await sql<{ id: string }[]>`
      SELECT id
      FROM source_citations
      WHERE entity_type = 'design_revision'
        AND entity_id = ${publishedGraph.revisionId}
        AND review_status = 'accepted'
      LIMIT 1
    `;
    if (!acceptedRevisionCitation) throw new Error("Published revision citation fixture was not found.");

    await database.insert(schema.productIdentifiers).values({
      productModelId: publishedGraph.modelId,
      displayValue: "WP07-UNCITED-ALIAS",
      strictKey: "WP07-UNCITED-ALIAS",
      looseKey: "WP07UNCITEDALIAS",
      identifierType: "alias",
    });
    const publicEdgeCount = async (): Promise<number> => {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
      `;
      return row?.count ?? -1;
    };
    if (await publicEdgeCount() !== 1) throw new Error("A fully cited eligible record was not public.");

    const catalogueCleanupConsent = new Date("2026-02-01T00:00:00.000Z");
    const catalogueCleanupDeleted = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: catalogueCleanupConsent,
      consentedAt: catalogueCleanupConsent,
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contentFingerprint: "catalogue-cleanup-delete-content".padEnd(64, "0"),
      contributorKey: "catalogue-cleanup-delete-contributor".padEnd(64, "0"),
      idempotencyKeyHash: "catalogue-cleanup-delete-idempotency".padEnd(64, "0"),
      requestFingerprint: "catalogue-cleanup-delete-request".padEnd(64, "0"),
      retentionExpiresAt: new Date("2026-02-02T00:00:00.000Z"),
    }, database);
    const catalogueCleanupRedacted = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: catalogueCleanupConsent,
      consentedAt: catalogueCleanupConsent,
      contactEmail: "catalogue-cleanup-private@example.invalid",
      contactRetentionExpiresAt: new Date("2026-02-02T00:00:00.000Z"),
      contentFingerprint: "catalogue-cleanup-redact-content".padEnd(64, "0"),
      contributorKey: "catalogue-cleanup-redact-contributor".padEnd(64, "0"),
      idempotencyKeyHash: "catalogue-cleanup-redact-idempotency".padEnd(64, "0"),
      requestFingerprint: "catalogue-cleanup-redact-request".padEnd(64, "0"),
      retentionExpiresAt: new Date("2026-04-01T00:00:00.000Z"),
    }, database);
    const [publicCountsBeforeCleanup] = await sql<{ catalogue: number; search: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public_catalogue_fitments) AS catalogue,
        (SELECT count(*)::int FROM public_search_documents) AS search
    `;
    const catalogueCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(
      database,
      new Date("2026-03-01T00:00:00.000Z"),
      2,
    );
    const [publicCountsAfterCleanup] = await sql<{ catalogue: number; search: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public_catalogue_fitments) AS catalogue,
        (SELECT count(*)::int FROM public_search_documents) AS search
    `;
    if (
      catalogueCleanup.deletedSubmissions !== 1
      || catalogueCleanup.redactedContacts !== 1
      || !publicCountsBeforeCleanup
      || !publicCountsAfterCleanup
      || publicCountsBeforeCleanup.catalogue < 1
      || publicCountsBeforeCleanup.catalogue !== publicCountsAfterCleanup.catalogue
      || publicCountsBeforeCleanup.search !== publicCountsAfterCleanup.search
    ) {
      throw new Error("Private retention cleanup changed an eligible public catalogue/search surface.");
    }
    const [catalogueCleanupPrivateEvidence] = await sql<{
      deleted: number;
      redactedEmail: string | null;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions WHERE id = ${catalogueCleanupDeleted.id}) AS deleted,
        contact_email AS "redactedEmail"
      FROM submissions WHERE id = ${catalogueCleanupRedacted.id}
    `;
    if (
      !catalogueCleanupPrivateEvidence
      || catalogueCleanupPrivateEvidence.deleted !== 0
      || catalogueCleanupPrivateEvidence.redactedEmail !== null
    ) {
      throw new Error("Catalogue-safe cleanup did not erase its private submission fixtures.");
    }
    await database.delete(schema.submissions).where(eq(schema.submissions.id, catalogueCleanupRedacted.id));

    await sql`UPDATE source_citations SET review_status = 'rejected' WHERE id = ${primaryIdentifierClaim.id}`;
    if (await publicEdgeCount() !== 0) throw new Error("A model without an accepted cited primary identifier remained public.");
    await sql`UPDATE source_citations SET review_status = 'accepted' WHERE id = ${primaryIdentifierClaim.id}`;

    for (const status of ["pending", "rejected"] as const) {
      await sql`UPDATE source_citations SET review_status = ${status} WHERE id = ${targetMappingClaim.id}`;
      if (await publicEdgeCount() !== 0) throw new Error(`A ${status} product-component mapping citation qualified for publication.`);
    }
    await sql`UPDATE source_citations SET review_status = 'accepted', field_path = 'wrong_field' WHERE id = ${targetMappingClaim.id}`;
    if (await publicEdgeCount() !== 0) throw new Error("A product-component citation for the wrong field qualified for publication.");
    await sql`UPDATE source_citations SET field_path = 'mapping', entity_id = '00000000-0000-4000-8000-00000000ffff' WHERE id = ${targetMappingClaim.id}`;
    if (await publicEdgeCount() !== 0) throw new Error("A citation belonging to another entity qualified a product-component mapping.");
    await sql`UPDATE source_citations SET entity_id = ${seedIds.productComponent} WHERE id = ${targetMappingClaim.id}`;
    await sql`UPDATE product_components SET source_citation_id = ${primaryIdentifierClaim.id} WHERE id = ${seedIds.productComponent}`;
    if (await publicEdgeCount() !== 0) throw new Error("A product-component row pointing at another accepted citation qualified for publication.");
    await sql`UPDATE product_components SET source_citation_id = ${targetMappingClaim.id} WHERE id = ${seedIds.productComponent}`;
    await sql`UPDATE sources SET status = 'removed' WHERE id = ${catalogueClaimSource.id}`;
    if (await publicEdgeCount() !== 0) throw new Error("An unavailable provenance source qualified a public catalogue edge.");
    await sql`UPDATE sources SET status = 'live' WHERE id = ${catalogueClaimSource.id}`;
    if (await publicEdgeCount() !== 1) throw new Error("A restored, fully cited catalogue edge did not return to the public view.");

    await sql`UPDATE design_revisions SET rights_checked_by = NULL WHERE id = ${publishedGraph.revisionId}`;
    if (await publicEdgeCount() !== 0) throw new Error("A revision without an independent rights reviewer remained public.");
    await sql`UPDATE design_revisions SET rights_checked_by = ${reviewerIdentity.id} WHERE id = ${publishedGraph.revisionId}`;
    if (await publicEdgeCount() !== 1) throw new Error("A rights-reviewed eligible revision did not return to the public view.");

    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [uncitedAliasLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_search_documents
      WHERE entity_id = ${publishedGraph.modelId}
        AND (
          strict_keys @> ARRAY['WP07-UNCITED-ALIAS']::text[]
          OR loose_keys @> ARRAY['WP07UNCITEDALIAS']::text[]
          OR search_text LIKE '%wp07-uncited-alias%'
        )
    `;
    if (uncitedAliasLeak?.count !== 0) throw new Error("An uncited model alias leaked into public search.");

    const [secondModel] = await database.insert(schema.productModels).values({
      publicId: "mdl_catalogue_region_b",
      brandId: seedIds.brand,
      categoryId: seedIds.category,
      modelName: "DV/100 Region B",
      slug: "dv-100-region-b",
      marketCodes: ["REGION-B"],
      labelLocation: "Fictional underside label fixture.",
      publicationStatus: "published",
      publishedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.productModels.id });
    if (!secondModel) throw new Error("Second exact-model catalogue fixture was not created.");
    const [secondIdentifier] = await database.insert(schema.productIdentifiers).values({
      productModelId: secondModel.id,
      displayValue: "DV/100",
      strictKey: "DV/100",
      looseKey: "DV100",
      identifierType: "label",
      marketCode: "REGION-B",
    }).returning({ id: schema.productIdentifiers.id });
    const [secondProductComponent] = await database.insert(schema.productComponents).values({
      productModelId: secondModel.id,
      componentId: publishedGraph.componentId,
      mappingStatus: "accepted",
    }).returning({ id: schema.productComponents.id });
    if (!secondIdentifier || !secondProductComponent) throw new Error("Second exact-model target fixture was not created.");
    const secondTargetClaims = await database.insert(schema.sourceCitations).values([
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_model",
        entityId: secondModel.id,
        fieldPath: "model_name",
        claimValue: "DV/100 Region B",
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_identifier",
        entityId: secondIdentifier.id,
        fieldPath: "display_value",
        claimValue: "DV/100",
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        sourceId: catalogueClaimSource.id,
        entityType: "product_component",
        entityId: secondProductComponent.id,
        fieldPath: "mapping",
        claimValue: { productModelId: secondModel.id, componentId: publishedGraph.componentId, oemPartId: null },
        extractionMethod: "editorial",
        reviewStatus: "accepted" as const,
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ]).returning({ id: schema.sourceCitations.id, entityType: schema.sourceCitations.entityType });
    const secondIdentifierClaim = secondTargetClaims.find((row) => row.entityType === "product_identifier");
    const secondMappingClaim = secondTargetClaims.find((row) => row.entityType === "product_component");
    if (!secondIdentifierClaim || !secondMappingClaim) throw new Error("Second exact-model provenance citations were not created.");
    await sql`UPDATE product_identifiers SET source_citation_id = ${secondIdentifierClaim.id} WHERE id = ${secondIdentifier.id}`;
    await sql`UPDATE product_components SET source_citation_id = ${secondMappingClaim.id} WHERE id = ${secondProductComponent.id}`;
    await database.insert(schema.safetyReviews).values({
      productComponentId: secondProductComponent.id,
      safetyClass: "low",
      signals: ["low_load_clip"],
      failureConsequence: "Inconvenience only",
      rationale: "Fictional independently reviewed low-load fixture.",
      rulesetVersion: "safety-v1",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });

    const [secondRevision] = await database.insert(schema.designRevisions).values({
      designId: publishedGraph.designId,
      sourceId: publishedGraph.sourceId,
      sourceRevision: "r2",
      sourceExternalId: "editorial-publishable-latch-r2",
      licenseCode: "NOT-STATED",
      attributionText: "Fictional latch revision two by Fictional workflow creator",
      fileFormats: ["STL"],
      rightsCheckedAt: new Date("2026-07-12T00:00:00Z"),
      rightsCheckedBy: reviewerIdentity.id,
    }).returning({ id: schema.designRevisions.id });
    if (!secondRevision) throw new Error("Second design-revision fixture was not created.");
    const [secondRevisionCitation] = await database.insert(schema.sourceCitations).values({
      sourceId: publishedGraph.sourceId,
      entityType: "design_revision",
      entityId: secondRevision.id,
      fieldPath: "claimed_compatibility",
      claimValue: { fixture: "revision-two" },
      locator: "Explicit WP-07 integration fixture",
      extractionMethod: "editorial",
      reviewStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.sourceCitations.id });
    if (!secondRevisionCitation) throw new Error("Second revision citation fixture was not created.");

    const [secondModelFitment] = await database.insert(schema.fitments).values({
      publicId: "fit_catalogue_region_b_r1",
      slug: "catalogue-region-b-latch-r1",
      designRevisionId: publishedGraph.revisionId,
      productComponentId: secondProductComponent.id,
      confidenceLevel: "verified_fit",
      confidenceScore: 100,
      confidenceVersion: "fitment-v1",
      publicationStatus: "published",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
      lastComputedAt: new Date("2026-07-12T00:00:00Z"),
      publishedAt: new Date("2026-07-13T00:00:00Z"),
    }).returning({ id: schema.fitments.id });
    if (!secondModelFitment) throw new Error("Second exact-model fitment fixture was not created.");
    const [secondModelEvidence] = await database.insert(schema.fitmentEvidence).values({
      fitmentId: secondModelFitment.id,
      evidenceKind: "trusted_physical_test",
      outcome: "fits_without_modification",
      actorIndependenceKey: "wp07-region-b-reviewer",
      exactModel: true,
      exactDesignRevision: true,
      hasInstalledPhoto: true,
      summary: "WP-07_REGION_B_REVISION_ONE_EVIDENCE",
      observedAt: "2026-07-12",
      moderationStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.fitmentEvidence.id });
    if (!secondModelEvidence) throw new Error("Second exact-model evidence fixture was not created.");
    const [secondModelEvidenceCitation] = await database.insert(schema.sourceCitations).values({
      sourceId: publishedGraph.sourceId,
      entityType: "fitment_evidence",
      entityId: secondModelEvidence.id,
      fieldPath: "observation",
      claimValue: { outcome: "fits_without_modification", exactModel: true, exactDesignRevision: true },
      locator: "Explicit WP-07 physical-test fixture",
      extractionMethod: "editorial",
      reviewStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    }).returning({ id: schema.sourceCitations.id });
    if (!secondModelEvidenceCitation) throw new Error("Second exact-model evidence citation was not created.");
    await sql`UPDATE fitment_evidence SET source_citation_id = ${secondModelEvidenceCitation.id} WHERE id = ${secondModelEvidence.id}`;

    const [secondRevisionFitment] = await database.insert(schema.fitments).values({
      publicId: "fit_catalogue_region_a_r2",
      slug: "catalogue-region-a-latch-r2",
      designRevisionId: secondRevision.id,
      productComponentId: seedIds.productComponent,
      confidenceLevel: "creator_listed",
      confidenceScore: 55,
      confidenceVersion: "fitment-v1",
      publicationStatus: "published",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
      lastComputedAt: new Date("2026-07-12T00:00:00Z"),
      publishedAt: new Date("2026-07-13T00:00:00Z"),
    }).returning({ id: schema.fitments.id });
    if (!secondRevisionFitment) throw new Error("Second design-revision fitment fixture was not created.");
    await database.insert(schema.fitmentEvidence).values({
      fitmentId: secondRevisionFitment.id,
      evidenceKind: "creator_claim",
      outcome: "fits_without_modification",
      sourceCitationId: secondRevisionCitation.id,
      actorIndependenceKey: "wp07-creator-revision-two",
      exactModel: true,
      exactDesignRevision: true,
      summary: "WP-07_REGION_A_REVISION_TWO_EVIDENCE",
      observedAt: "2026-07-12",
      moderationStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });
    await database.insert(schema.printRecipes).values([
      {
        fitmentId: secondModelFitment.id,
        material: "PETG",
        layerHeightMm: 0.2,
        wallCount: 4,
        infillPercent: 35,
        supports: "None",
        orientation: "Broad face down",
        provenance: "editorial",
      },
      {
        fitmentId: secondRevisionFitment.id,
        material: "PETG",
        layerHeightMm: 0.16,
        wallCount: 5,
        infillPercent: 40,
        supports: "Build plate only",
        orientation: "Revision-two documented orientation",
        provenance: "creator_sourced",
      },
    ]).returning({ id: schema.printRecipes.id, fitmentId: schema.printRecipes.fitmentId });
    const recipeRows = await sql<{ id: string; fitmentId: string }[]>`
      SELECT id, fitment_id AS "fitmentId"
      FROM print_recipes
      WHERE fitment_id IN (${secondModelFitment.id}, ${secondRevisionFitment.id})
    `;
    for (const recipe of recipeRows) {
      const [recipeCitation] = await database.insert(schema.sourceCitations).values({
        sourceId: publishedGraph.sourceId,
        entityType: "print_recipe",
        entityId: recipe.id,
        fieldPath: "settings",
        claimValue: { fitmentId: recipe.fitmentId, fixture: "WP-07 reviewed print recipe" },
        locator: "Explicit WP-07 print-recipe fixture",
        extractionMethod: "editorial",
        reviewStatus: "accepted",
        reviewedBy: reviewerIdentity.id,
        reviewedAt: new Date("2026-07-12T00:00:00Z"),
      }).returning({ id: schema.sourceCitations.id });
      if (!recipeCitation) throw new Error("Print-recipe citation fixture was not created.");
      await sql`UPDATE print_recipes SET source_citation_id = ${recipeCitation.id} WHERE id = ${recipe.id}`;
    }

    const catalogueEdges = await sql<{
      fitmentId: string;
      modelId: string;
      revisionId: string;
      status: string;
      canonicalSlug: string;
    }[]>`
      SELECT
        fitment_id AS "fitmentId",
        model_id AS "modelId",
        revision_id AS "revisionId",
        fitment_status AS status,
        canonical_slug AS "canonicalSlug"
      FROM public_catalogue_fitments
      WHERE design_id = ${publishedGraph.designId}
        AND component_id = ${publishedGraph.componentId}
      ORDER BY fitment_id
    `;
    if (catalogueEdges.length !== 3) {
      throw new Error(`Expected three independently eligible catalogue edges, found ${JSON.stringify(catalogueEdges)}.`);
    }
    if (catalogueEdges.some((edge) => edge.canonicalSlug !== publishedGraph.fitmentSlug)) {
      throw new Error("Grouped fitment slugs did not converge on one stable canonical part path.");
    }
    await sql`UPDATE fitments SET publication_status = 'archived' WHERE id = ${prepared.fitmentId}`;
    const archivedCanonicalRows = await sql<{ fitmentSlug: string; canonicalSlug: string }[]>`
      SELECT fitment_slug AS "fitmentSlug", canonical_slug AS "canonicalSlug"
      FROM public_catalogue_fitments
      WHERE design_id = ${publishedGraph.designId} AND component_id = ${publishedGraph.componentId}
    `;
    const replacementCanonical = archivedCanonicalRows[0]?.canonicalSlug;
    if (
      archivedCanonicalRows.length !== 2
      || !replacementCanonical
      || replacementCanonical === publishedGraph.fitmentSlug
      || archivedCanonicalRows.some((row) => row.canonicalSlug !== replacementCanonical)
      || !archivedCanonicalRows.some((row) => row.fitmentSlug === replacementCanonical)
    ) {
      throw new Error(`An archived earliest fitment remained canonical or no eligible sibling replaced it: ${JSON.stringify(archivedCanonicalRows)}.`);
    }
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const archivedCanonicalSearch = await sql<{ href: string }[]>`
      SELECT href FROM public_search_documents
      WHERE entity_type = 'part' AND entity_id IN (${prepared.fitmentId}, ${secondModelFitment.id}, ${secondRevisionFitment.id})
    `;
    if (
      archivedCanonicalSearch.some((row) => row.href === `/parts/${publishedGraph.fitmentSlug}`)
      || archivedCanonicalSearch.some((row) => row.href !== `/parts/${replacementCanonical}`)
    ) {
      throw new Error(`Search retained an ineligible canonical fitment: ${JSON.stringify(archivedCanonicalSearch)}.`);
    }
    await sql`UPDATE fitments SET publication_status = 'published' WHERE id = ${prepared.fitmentId}`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const firstModelStatus = catalogueEdges.find((edge) => edge.fitmentId === prepared.fitmentId)?.status;
    const secondModelStatus = catalogueEdges.find((edge) => edge.fitmentId === secondModelFitment.id)?.status;
    if (firstModelStatus !== "creator_listed" || secondModelStatus !== "verified_fit") {
      throw new Error("The same design revision did not retain different fitment labels for different exact models.");
    }
    await sql`UPDATE fitments SET confidence_level = 'candidate_match' WHERE id = ${secondRevisionFitment.id}`;
    const [candidateCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${secondRevisionFitment.id}
    `;
    if (candidateCatalogue?.count !== 0) throw new Error("Candidate fitments must not appear in the production catalogue.");
    await sql`UPDATE fitments SET confidence_level = 'creator_listed' WHERE id = ${secondRevisionFitment.id}`;
    const firstModelEdges = catalogueEdges.filter((edge) => edge.modelId === publishedGraph.modelId);
    if (firstModelEdges.length !== 2 || firstModelEdges.some((edge) => edge.fitmentId === secondModelFitment.id)) {
      throw new Error("Exact-model catalogue filtering leaked a cross-model fitment.");
    }

    const revisionEvidence = await sql<{ revisionId: string; summaries: string[] }[]>`
      SELECT
        catalogue.revision_id AS "revisionId",
        array_agg(evidence.summary ORDER BY evidence.summary) AS summaries
      FROM public_catalogue_fitments AS catalogue
      INNER JOIN fitment_evidence AS evidence ON evidence.fitment_id = catalogue.fitment_id
        AND evidence.moderation_status = 'accepted'
      WHERE catalogue.design_id = ${publishedGraph.designId}
        AND catalogue.model_id = ${publishedGraph.modelId}
      GROUP BY catalogue.revision_id
    `;
    const revisionTwoEvidence = revisionEvidence.find((row) => row.revisionId === secondRevision.id)?.summaries ?? [];
    const revisionOneEvidence = revisionEvidence.find((row) => row.revisionId === publishedGraph.revisionId)?.summaries ?? [];
    if (!revisionTwoEvidence.includes("WP-07_REGION_A_REVISION_TWO_EVIDENCE") || revisionOneEvidence.includes("WP-07_REGION_A_REVISION_TWO_EVIDENCE")) {
      throw new Error("Evidence leaked between separate design revisions.");
    }

    await sql`
      UPDATE submissions
      SET payload = payload || ${JSON.stringify({ email: "private-catalogue@example.invalid", notes: "WP07_PRIVATE_SUBMISSION_SENTINEL" })}::jsonb
      WHERE id = ${creatorSubmission.id}
    `;
    const [privateLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public_catalogue_fitments AS catalogue
      WHERE to_jsonb(catalogue)::text LIKE '%WP07_PRIVATE_SUBMISSION_SENTINEL%'
        OR to_jsonb(catalogue)::text LIKE '%private-catalogue@example.invalid%'
    `;
    if (privateLeak?.count !== 0) throw new Error("Private submission payload leaked into a public catalogue response row.");

    await database.insert(schema.sourcePlatformPolicies).values({
      platform: "example",
      policy: "creator_submission",
      termsUrl: "https://example.invalid/fixture-policy",
      termsCheckedAt: new Date("2026-07-12T00:00:00Z"),
      permissionScope: "Test-only demo exclusion fixture.",
      allowedFields: ["fixture"],
    }).onConflictDoNothing();
    await database.insert(schema.sourceCitations).values({
      sourceId: seedIds.source,
      entityType: "design_revision",
      entityId: seedIds.revision,
      fieldPath: "fixture",
      claimValue: { fixture: true },
      extractionMethod: "fixture",
      reviewStatus: "accepted",
      reviewedBy: reviewerIdentity.id,
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    });
    await sql`UPDATE designs SET publication_status = 'published' WHERE id = ${seedIds.design}`;
    await sql`
      UPDATE fitments
      SET publication_status = 'published', reviewed_by = ${reviewerIdentity.id}, reviewed_at = now(), published_at = now()
      WHERE id = ${seedIds.fitment}
    `;
    const [demoLeak] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${seedIds.fitment}
    `;
    if (demoLeak?.count !== 0) throw new Error("A source_type=demo fixture leaked into the production catalogue view.");
    await sql`UPDATE fitments SET publication_status = 'draft', published_at = NULL WHERE id = ${seedIds.fitment}`;
    await sql`UPDATE designs SET publication_status = 'draft' WHERE id = ${seedIds.design}`;

    await sql`UPDATE sources SET status = 'removed' WHERE id = ${publishedGraph.sourceId}`;
    await sql`UPDATE designs SET availability_status = 'removed' WHERE id = ${publishedGraph.designId}`;
    const [removedEligible] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE design_id = ${publishedGraph.designId}
    `;
    const [removedTombstones] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_unavailable_sources WHERE design_public_id = (
        SELECT public_id FROM designs WHERE id = ${publishedGraph.designId}
      )
    `;
    if (removedEligible?.count !== 0 || removedTombstones?.count !== 3) {
      throw new Error("Removed source records were not excluded from listings and retained as honest unavailable tombstones.");
    }
    await sql`UPDATE fitment_evidence SET source_citation_id = NULL WHERE fitment_id = ${prepared.fitmentId}`;
    const [uncitedTombstone] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_unavailable_sources WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (uncitedTombstone?.count !== 0) throw new Error("An uncited evidence claim created an approved unavailable-source tombstone.");
    await sql`
      UPDATE fitment_evidence
      SET source_citation_id = ${acceptedRevisionCitation.id}
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    const [restoredTombstone] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_unavailable_sources WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (restoredTombstone?.count !== 1) throw new Error("A fully reviewed removed-source tombstone did not return after provenance restoration.");
    await sql`UPDATE sources SET status = 'live' WHERE id = ${publishedGraph.sourceId}`;
    await sql`UPDATE designs SET availability_status = 'available' WHERE id = ${publishedGraph.designId}`;

    await database.insert(schema.slugHistory).values([
      {
        entityType: "fitment",
        entityId: secondModelFitment.id,
        oldPath: "/parts/wp07-old-slug",
        replacementPath: "/parts/wp07-intermediate-slug",
      },
      {
        entityType: "fitment",
        entityId: secondModelFitment.id,
        oldPath: "/parts/wp07-intermediate-slug",
        replacementPath: `/parts/${publishedGraph.fitmentSlug}`,
      },
    ]);
    const redirectRows = await sql<{ oldPath: string; replacementPath: string }[]>`
      SELECT old_path AS "oldPath", replacement_path AS "replacementPath" FROM slug_history
    `;
    if (resolveRedirectChain(redirectRows, "/parts/wp07-old-slug") !== `/parts/${publishedGraph.fitmentSlug}`) {
      throw new Error("Historical slug did not resolve directly to the final canonical part path.");
    }

    const catalogueRepositoryCheck = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "scripts/check-public-catalogue-repository.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DEMO_MODE: "false",
          WP07_TEST_BRAND_SLUG: "demovac",
          WP07_TEST_MODEL_SLUG: "dv-100",
          WP07_TEST_CANONICAL_SLUG: publishedGraph.fitmentSlug,
          WP07_TEST_ALTERNATE_SLUG: "catalogue-region-b-latch-r1",
          WP07_TEST_FITMENT_ID: prepared.fitmentId,
        },
      },
    );
    if (catalogueRepositoryCheck.stdout) process.stdout.write(catalogueRepositoryCheck.stdout);
    if (catalogueRepositoryCheck.status !== 0) {
      if (catalogueRepositoryCheck.stderr) process.stderr.write(catalogueRepositoryCheck.stderr);
      throw new Error("Server-only public catalogue repository integration check failed.");
    }

    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const canonicalSearchPaths = await sql<{ href: string }[]>`
      SELECT href
      FROM public_search_documents
      WHERE entity_type = 'part'
        AND entity_id IN (${prepared.fitmentId}, ${secondModelFitment.id}, ${secondRevisionFitment.id})
    `;
    if (canonicalSearchPaths.length !== 3 || canonicalSearchPaths.some((row) => row.href !== `/parts/${publishedGraph.fitmentSlug}`)) {
      throw new Error("Search results did not converge grouped fitments on the canonical part page.");
    }
    await sql`
      UPDATE fitments
      SET publication_status = 'draft', published_at = NULL
      WHERE id IN (${secondModelFitment.id}, ${secondRevisionFitment.id})
    `;

    await sql`UPDATE safety_reviews SET safety_class = 'caution' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [cautionSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (cautionSearch?.count !== 0) throw new Error("Caution-class fitments must not appear in public search.");
    const [cautionCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (cautionCatalogue?.count !== 0) throw new Error("Caution-class fitments must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET safety_class = 'blocked' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [blockedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (blockedSearch?.count !== 0) throw new Error("Blocked fitments must not appear in public search.");
    const [blockedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (blockedCatalogue?.count !== 0) throw new Error("Blocked fitments must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET safety_class = 'low' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`UPDATE fitments SET confidence_version = 'fitment-v0' WHERE id = ${prepared.fitmentId}`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [staleFitmentRulesetSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (staleFitmentRulesetSearch?.count !== 0) throw new Error("Stale fitment-ruleset records must not appear in public search.");
    const [staleFitmentRulesetCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (staleFitmentRulesetCatalogue?.count !== 0) throw new Error("Stale fitment-ruleset records must not appear in the public catalogue.");

    await sql`UPDATE fitments SET confidence_version = 'fitment-v1' WHERE id = ${prepared.fitmentId}`;
    await sql`UPDATE safety_reviews SET ruleset_version = 'safety-v0' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v1'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [staleSafetyRulesetSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (staleSafetyRulesetSearch?.count !== 0) throw new Error("Stale safety-ruleset records must not appear in public search.");
    const [staleSafetyRulesetCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (staleSafetyRulesetCatalogue?.count !== 0) throw new Error("Stale safety-ruleset records must not appear in the public catalogue.");

    await sql`UPDATE safety_reviews SET ruleset_version = 'safety-v1' WHERE product_component_id = ${seedIds.productComponent} AND ruleset_version = 'safety-v0'`;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [restoredEligibleSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (restoredEligibleSearch?.count !== 1) throw new Error("Restored eligible fitment did not return to public search.");
    const [restoredEligibleCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (restoredEligibleCatalogue?.count !== 1) throw new Error("Restored eligible fitment did not return to the public catalogue.");

    const [negativeEvidence] = await database
      .insert(schema.fitmentEvidence)
      .values({
        fitmentId: prepared.fitmentId,
        evidenceKind: "community_report",
        outcome: "does_not_fit",
        actorIndependenceKey: "fictional-negative-reporter",
        exactModel: true,
        exactDesignRevision: true,
        summary: "Fictional accepted incompatibility report.",
        observedAt: "2026-07-11",
        moderationStatus: "pending",
      })
      .returning({ id: schema.fitmentEvidence.id });
    if (!negativeEvidence) throw new Error("Negative evidence fixture was not created.");
    const disputed = await moderateEvidence(database, negativeEvidence.id, reviewerIdentity, {
      decision: "accepted",
      reason: "Accepted exact-model incompatibility report opens a dispute.",
      requestId: "req_editorial_dispute",
    });
    if (disputed.confidenceLevel !== "disputed" || disputed.publicationStatus !== "needs_review") {
      throw new Error("Accepted incompatibility evidence did not immediately remove publication eligibility.");
    }
    const [disputedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (disputedSearch?.count !== 0) throw new Error("Disputed fitment remained in public search after refresh.");
    const [disputedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (disputedCatalogue?.count !== 0) throw new Error("Disputed fitment remained in the public catalogue.");

    await sql`UPDATE fitment_evidence SET moderation_status = 'rejected' WHERE id = ${negativeEvidence.id}`;
    await sql`
      UPDATE fitments
      SET confidence_level = 'creator_listed', confidence_score = 55, confidence_version = 'fitment-v1', publication_status = 'published'
      WHERE id = ${prepared.fitmentId}
    `;
    await sql`REFRESH MATERIALIZED VIEW public_search_documents`;
    const [restoredBeforeArchive] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (restoredBeforeArchive?.count !== 1) throw new Error("Archive fixture could not restore an eligible search document.");

    await archiveFitment(database, prepared.fitmentId, adminIdentity, {
      replacementPath: "/",
      reason: "Archive disputed fictional fitment while retaining evidence and redirect history.",
      requestId: "req_editorial_archive",
    });
    const [archivedSearch] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}
    `;
    if (archivedSearch?.count !== 0) throw new Error("Archived fitment remained in public search after refresh.");
    const [archivedCatalogue] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (archivedCatalogue?.count !== 0) throw new Error("Archived fitment remained in the public catalogue.");

    const [rejectedSubmission] = await database
      .insert(schema.submissions)
      .values({
        kind: "design_submission",
        status: "pending",
        payload: {
          sourceUrl: "https://example.invalid/editorial/rejected-latch",
          creatorName: "Fictional rejected creator",
          brand: "DemoVac",
          modelNumber: "DV-100",
          componentName: "Dust-bin latch",
          claimedLicense: "NOT-STATED",
          notes: "Fictional rejection branch.",
          email: "",
          website: "",
        },
      })
      .returning({ id: schema.submissions.id });
    if (!rejectedSubmission) throw new Error("Rejected submission fixture was not created.");
    await prepareCreatorSubmission(database, rejectedSubmission.id, editorIdentity, {
      productComponentId: seedIds.productComponent,
      confirmExactTarget: true,
      designTitle: "Fictional rejected workflow fixture",
      creatorPlatform: "example.invalid",
      sourcePlatform: "example.invalid",
      sourceExternalId: "editorial-rejected-latch",
      sourceRevision: "r1",
      sourceTitle: "Fictional rejected landing page",
      licenseCode: "NOT-STATED",
      licenseVersion: "",
      licenseUrl: "",
      licenseEvidenceUrl: "https://example.invalid/editorial/rejected-latch",
      attributionText: "Fictional rejected latch attribution",
      fileFormats: ["STL"],
      observedAt: "2026-07-11",
      evidenceSummary: "Fictional claim queued for rejection coverage.",
      reason: "Prepare fictional rejection branch.",
      requestId: "req_editorial_reject_prepare",
    });
    const rejected = await reviewCreatorSubmission(database, rejectedSubmission.id, reviewerIdentity, {
      decision: "reject",
      safetyClass: "low",
      safetySignals: ["low_load_clip"],
      safetyRationale: "Fixture value is ignored on rejection.",
      reason: "Reject fictional submission after independent source review.",
      requestId: "req_editorial_reject",
    });
    if (rejected.status !== "rejected") throw new Error("Editorial rejection branch did not finish rejected.");

    const [editorialCounts] = await sql<{ archivedFitments: number; evidenceRows: number; redirects: number; transitions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM fitments WHERE id = ${prepared.fitmentId} AND publication_status = 'archived') AS "archivedFitments",
        (SELECT count(*)::int FROM fitment_evidence WHERE fitment_id = ${prepared.fitmentId}) AS "evidenceRows",
        (SELECT count(*)::int FROM slug_history WHERE entity_id = ${prepared.fitmentId}) AS redirects,
        (SELECT count(*)::int FROM audit_log WHERE action IN ('editorial.case.prepare', 'editorial.case.accept', 'publication.fitment.publish', 'evidence.moderate', 'fitment.archive', 'editorial.case.reject')) AS transitions
    `;
    if (
      editorialCounts?.archivedFitments !== 1 ||
      editorialCounts.evidenceRows !== 2 ||
      editorialCounts.redirects !== 1 ||
      editorialCounts.transitions !== 7
    ) {
      throw new Error(`Editorial workflow evidence is incomplete: ${JSON.stringify(editorialCounts)}.`);
    }

    const [audit] = await sql<{ id: string }[]>`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${staff.id}, 'fixture.review', 'fitment', '00000000-0000-4000-8000-000000000201',
        '{}'::jsonb, '{"status":"reviewed"}'::jsonb, 'Fresh database fixture.', 'req_database_gate')
      RETURNING id
    `;
    if (!audit) throw new Error("Audit fixture was not written.");

    let mutationRejected = false;
    try {
      await sql`DELETE FROM audit_log WHERE id = ${audit.id}`;
    } catch (error) {
      mutationRejected = error instanceof Error && error.message.includes("audit_log is append-only");
    }
    if (!mutationRejected) throw new Error("Audit rows must reject update/delete mutations.");

    const [anonymousPublished] = await sql<{ rowCount: number }[]>`
      SELECT count(*)::int AS "rowCount" FROM published_fitments
    `;
    if (anonymousPublished?.rowCount !== 0) {
      throw new Error("Anonymous published view exposed a fictional draft fitment.");
    }

    console.log("Database checks passed: migrations, seed, idempotent import, exact catalog drafts, production search view, independent editorial publish/reject/dispute/archive journeys, published views, staff constraints, and immutable audit are valid.");
  } finally {
    await sql.end();
  }
}

function hasDatabaseErrorCode(error: unknown, expectedCode: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current && current.code === expectedCode) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
