import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { NextRequest } from "next/server";
import postgres from "postgres";

import { assertSafeTestDatabaseUrl } from "./database-safety";
import { resolveRedirectChain } from "../src/domain/catalogue";
import { classifySourceLinkStatus } from "../src/domain/source-link-health";
import { semanticSubmissionPayload } from "../src/domain/submissions";
import {
  assessSubmissionRoleMemberships,
  type SubmissionRoleMembership,
} from "../src/domain/submission-role-membership";
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
import { handleAnonymousSubmission, type SubmissionApiDependencies } from "../src/lib/submission-api";
import {
  CONTACT_CONSENT_VERSION,
  CONTRIBUTOR_TERMS_VERSION,
  PRIVACY_NOTICE_VERSION,
} from "../src/lib/submission-constants";
import { missingPartRequestIntakeStructuralSchema } from "../src/lib/submission-schemas";
import { parseSubmissionHmacSecret, trustedSubmissionClientIp } from "../src/lib/submission-security";
import {
  deriveSubmissionHmacKeyCommitment,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
} from "../src/lib/submission-key-pin";
import type { AnonymousSubmissionPersistence } from "../src/lib/submissions";
import type { PersistAnonymousSubmissionInput } from "../src/db/submissions";

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
    // Exercise migration 0006 when safe provider-managed roles already exist.
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_submission_service') THEN
          CREATE ROLE repairprint_submission_service
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairprint_submission_maintenance') THEN
          CREATE ROLE repairprint_submission_maintenance
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
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
    if (tableCount !== 43) throw new Error(`Expected 43 public tables after migration, found ${tableCount}.`);
    const [enumInventory] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND type.typtype = 'e'
    `;
    if (enumInventory?.count !== 24) throw new Error(`Expected 24 public enums after migration, found ${enumInventory?.count}.`);

    const rawSubmissionRepository = await import("../src/db/submissions");
    const submissionRepository = {
      ...rawSubmissionRepository,
      persistAnonymousSubmission: (
        input: PersistFixtureInput,
        targetDatabase: Parameters<typeof rawSubmissionRepository.persistAnonymousSubmission>[1],
      ) => rawSubmissionRepository.persistAnonymousSubmission(completePersistFixture(input), targetDatabase),
    };
    process.env.SUBMISSION_HMAC_SECRET = generateSubmissionTestHmacSecret();
    await database.insert(schema.submissionHmacKeyPin).values({
      hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
      keyCommitment: deriveSubmissionHmacKeyCommitment(),
    });
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
      idempotencyActorKey: "actor-a".padEnd(64, "0"),
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
    const idempotentRetryChecks = {
      createdIsNew: !createdSubmission.duplicate,
      receiptIsOpaque: createdSubmission.receiptId !== createdSubmission.id,
      retryIsDuplicate: retriedSubmission.duplicate,
      sameReceipt: createdSubmission.receiptId === retriedSubmission.receiptId,
      sameSubmission: createdSubmission.id === retriedSubmission.id,
      createdFingerprintMatches: createdSubmission.requestFingerprint === fixtureDigest(baseSubmission.requestFingerprint),
      retryFingerprintMatches: retriedSubmission.requestFingerprint === fixtureDigest(baseSubmission.requestFingerprint),
    };
    if (Object.values(idempotentRetryChecks).some((passed) => !passed)) {
      throw new Error(`Idempotent submission retry did not resolve to one private queue row: ${JSON.stringify(idempotentRetryChecks)}`);
    }
    const mediaPrimary = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contentFingerprint: "media-primary-content".padEnd(64, "0"),
      contributorKey: "media-primary-contributor".padEnd(64, "0"),
      idempotencyActorKey: "media-primary-actor".padEnd(64, "0"),
      idempotencyKeyHash: "media-primary-idempotency".padEnd(64, "0"),
      payload: { ...baseSubmission.payload, modelNumber: "PRIVATE-MEDIA-100" },
      requestFingerprint: "media-primary-request".padEnd(64, "0"),
    }, database);
    const mediaAlias = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contentFingerprint: "media-primary-content".padEnd(64, "0"),
      contributorKey: "media-primary-contributor".padEnd(64, "0"),
      idempotencyActorKey: "media-primary-actor".padEnd(64, "0"),
      idempotencyKeyHash: "media-alias-idempotency".padEnd(64, "0"),
      payload: { ...baseSubmission.payload, modelNumber: "PRIVATE-MEDIA-100" },
      requestFingerprint: "media-alias-request".padEnd(64, "0"),
    }, database);
    if (mediaPrimary.duplicate || !mediaAlias.duplicate || mediaAlias.intakeId === mediaPrimary.intakeId) {
      throw new Error("Private-media alias fixture did not produce a separate exact intake.");
    }
    const mediaClock = new Date();
    const mediaNow = mediaClock.toISOString();
    const mediaFuture = new Date(mediaClock.getTime() + 86_400_000).toISOString();
    const mediaPastAccepted = new Date(mediaClock.getTime() - 2 * 86_400_000).toISOString();
    const mediaPastDeadline = new Date(mediaClock.getTime() - 86_400_000).toISOString();
    await sql`
      INSERT INTO private_media_upload_sessions
        (id, public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
          claimed_extension, claimed_bytes, capability_nonce_hash, capability_expires_at)
      VALUES
        ('90000000-0000-4000-8000-000000000001', 'media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ${mediaPrimary.intakeId}, 'missing_part', 'model_label',
          'quarantine/aa/aaaaaaaaaaaaaaaaaaaaaaaa', 'image/jpeg', 'jpg', 100, ${"a".repeat(64)}, ${mediaFuture}),
        ('90000000-0000-4000-8000-000000000002', 'media_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ${mediaAlias.intakeId}, 'missing_part', 'model_label',
          'quarantine/bb/bbbbbbbbbbbbbbbbbbbbbbbb', 'image/jpeg', 'jpg', 100, ${"b".repeat(64)}, ${mediaFuture}),
        ('90000000-0000-4000-8000-000000000003', 'media_cccccccccccccccccccccccccccccccc', ${mediaPrimary.intakeId}, 'missing_part', 'broken_part_context',
          'quarantine/cc/cccccccccccccccccccccccc', 'image/png', 'png', 100, ${"c".repeat(64)}, ${mediaPastDeadline})
    `;
    await sql`
      INSERT INTO private_media_consents
        (session_id, intake_id, owns_or_has_permission, private_storage_consent, derivative_processing_consent,
          public_display_consent, terms_version, privacy_version, retention_version, accepted_at, retention_deadline)
      VALUES
        ('90000000-0000-4000-8000-000000000001', ${mediaPrimary.intakeId}, true, true, true, false,
          'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture}),
        ('90000000-0000-4000-8000-000000000002', ${mediaAlias.intakeId}, true, true, true, false,
          'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture}),
        ('90000000-0000-4000-8000-000000000003', ${mediaPrimary.intakeId}, true, true, true, false,
          'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaPastAccepted}, ${mediaPastDeadline})
    `;
    let duplicateExactPurposeRejected = false;
    try {
      await sql`
        INSERT INTO private_media_upload_sessions
          (public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
            claimed_extension, claimed_bytes, capability_nonce_hash, capability_expires_at)
        VALUES ('media_dddddddddddddddddddddddddddddddd', ${mediaPrimary.intakeId}, 'missing_part', 'model_label',
          'quarantine/dd/dddddddddddddddddddddddd', 'image/jpeg', 'jpg', 100, ${"d".repeat(64)}, ${mediaFuture})
      `;
    } catch (error) { duplicateExactPurposeRejected = hasDatabaseErrorCode(error, "23505"); }
    if (!duplicateExactPurposeRejected) throw new Error("An exact intake accepted a duplicate media purpose.");
    const cleanupLease = "90000000-0000-4000-8000-000000000010";
    const claimedMedia = await sql<{ sessionId: string }[]>`
      SELECT session_id AS "sessionId" FROM public.claim_expired_private_media(1, ${cleanupLease})
    `;
    if (claimedMedia.length !== 1 || claimedMedia[0]?.sessionId !== "90000000-0000-4000-8000-000000000003") {
      throw new Error("Private-media cleanup crossed an exact intake or ignored database retention ordering.");
    }
    await sql`SELECT * FROM public.complete_private_media_cleanup(${cleanupLease}, ${claimedMedia.map((row) => row.sessionId)}::uuid[])`;
    const [mediaIsolation] = await sql<{ active: number; expired: number; publicDisplay: number }[]>`
      SELECT
        (SELECT count(*)::int FROM private_media_upload_sessions WHERE id IN
          ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002')) AS active,
        (SELECT count(*)::int FROM private_media_upload_sessions WHERE id = '90000000-0000-4000-8000-000000000003') AS expired,
        (SELECT count(*)::int FROM private_media_consents WHERE public_display_consent) AS "publicDisplay"
    `;
    if (mediaIsolation?.active !== 2 || mediaIsolation.expired !== 0 || mediaIsolation.publicDisplay !== 0) {
      throw new Error(`Private-media alias isolation or retention evidence failed: ${JSON.stringify(mediaIsolation)}.`);
    }
    const uploadRaceNonce = "wp09-upload-race-nonce";
    await sql`
      INSERT INTO private_media_upload_sessions
        (id, public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
          claimed_extension, claimed_bytes, capability_nonce_hash, capability_expires_at)
      VALUES
        ('90000000-0000-4000-8000-000000000004', 'media_dddddddddddddddddddddddddddddddd', ${mediaAlias.intakeId}, 'missing_part', 'installed_fit',
          'quarantine/dd/dddddddddddddddddddddddd', 'image/jpeg', 'jpg', 100,
          ${createHash("sha256").update(uploadRaceNonce).digest("hex")}, ${mediaPastDeadline})
    `;
    await sql`
      INSERT INTO private_media_consents
        (session_id, intake_id, owns_or_has_permission, private_storage_consent, derivative_processing_consent,
          public_display_consent, terms_version, privacy_version, retention_version, accepted_at, retention_deadline)
      VALUES ('90000000-0000-4000-8000-000000000004', ${mediaAlias.intakeId}, true, true, true, false,
        'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture})
    `;
    const uploadRaceLease = "90000000-0000-4000-8000-000000000011";
    const uploadRaceClaim = await sql<{ sessionId: string }[]>`
      SELECT session_id AS "sessionId" FROM public.claim_expired_private_media(1, ${uploadRaceLease})
    `;
    if (uploadRaceClaim[0]?.sessionId !== "90000000-0000-4000-8000-000000000004") {
      throw new Error("Upload-versus-cleanup race fixture was not claimed exactly.");
    }
    await sql`UPDATE private_media_upload_sessions SET capability_expires_at = ${mediaFuture} WHERE id = '90000000-0000-4000-8000-000000000004'`;
    const uploadTransition = await sql`
      UPDATE private_media_upload_sessions SET status = 'uploaded', uploaded_at = pg_catalog.clock_timestamp(),
        finalize_capability_expires_at = ${mediaFuture}, updated_at = pg_catalog.clock_timestamp()
      WHERE public_id = 'media_dddddddddddddddddddddddddddddddd' AND status = 'issued'
        AND capability_nonce_hash = ${createHash("sha256").update(uploadRaceNonce).digest("hex")}
        AND capability_expires_at > pg_catalog.clock_timestamp()
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      RETURNING id
    `;
    if (uploadTransition.length !== 0) throw new Error("Active cleanup lease accepted an upload transition.");
    await sql`UPDATE private_media_upload_sessions SET capability_expires_at = ${mediaPastDeadline} WHERE id = '90000000-0000-4000-8000-000000000004'`;
    await sql`SELECT * FROM public.complete_private_media_cleanup(${uploadRaceLease}, ARRAY['90000000-0000-4000-8000-000000000004']::uuid[])`;

    await sql`
      INSERT INTO private_media_upload_sessions
        (id, public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
          claimed_extension, claimed_bytes, status, capability_nonce_hash, capability_expires_at,
          finalize_capability_expires_at, uploaded_at)
      VALUES ('90000000-0000-4000-8000-000000000005', 'media_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ${mediaPrimary.intakeId}, 'missing_part', 'installed_fit',
        'quarantine/ee/eeeeeeeeeeeeeeeeeeeeeeee', 'image/jpeg', 'jpg', 100, 'uploaded', ${"e".repeat(64)},
        ${mediaPastDeadline}, ${mediaFuture}, pg_catalog.clock_timestamp())
    `;
    await sql`
      INSERT INTO private_media_consents
        (session_id, intake_id, owns_or_has_permission, private_storage_consent, derivative_processing_consent,
          public_display_consent, terms_version, privacy_version, retention_version, accepted_at, retention_deadline)
      VALUES ('90000000-0000-4000-8000-000000000005', ${mediaPrimary.intakeId}, true, true, true, false,
        'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture})
    `;
    const finalizeRaceLease = "90000000-0000-4000-8000-000000000012";
    const activeFinalizeClaim = await sql`
      SELECT session_id FROM public.claim_expired_private_media(10, ${finalizeRaceLease})
    `;
    if (activeFinalizeClaim.length !== 0) throw new Error("An expired upload capability shortened an advertised finalize capability.");
    await sql`UPDATE private_media_upload_sessions SET finalize_capability_expires_at = ${mediaPastDeadline} WHERE id = '90000000-0000-4000-8000-000000000005'`;
    const finalizeRaceClaim = await sql<{ sessionId: string }[]>`
      SELECT session_id AS "sessionId" FROM public.claim_expired_private_media(1, ${finalizeRaceLease})
    `;
    if (finalizeRaceClaim[0]?.sessionId !== "90000000-0000-4000-8000-000000000005") {
      throw new Error("Finalize-versus-cleanup race fixture was not claimed after finalize expiry.");
    }
    await sql`UPDATE private_media_upload_sessions SET finalize_capability_expires_at = ${mediaFuture} WHERE id = '90000000-0000-4000-8000-000000000005'`;
    const finalizeTransition = await sql`
      UPDATE private_media_upload_sessions SET status = 'processing', processing_lease_token = '90000000-0000-4000-8000-000000000013',
        processing_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes', updated_at = pg_catalog.clock_timestamp()
      WHERE public_id = 'media_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' AND status = 'uploaded'
        AND finalize_capability_expires_at > pg_catalog.clock_timestamp()
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      RETURNING id
    `;
    if (finalizeTransition.length !== 0) throw new Error("Active cleanup lease accepted a finalize transition.");
    let cleanupRevalidationRejected = false;
    try {
      await sql`SELECT * FROM public.complete_private_media_cleanup(${finalizeRaceLease}, ARRAY['90000000-0000-4000-8000-000000000005']::uuid[])`;
    } catch (error) { cleanupRevalidationRejected = hasDatabaseErrorCode(error, "55000"); }
    if (!cleanupRevalidationRejected) throw new Error("Cleanup completion did not revalidate the finalization state under lock.");
    await sql`UPDATE private_media_upload_sessions SET finalize_capability_expires_at = ${mediaPastDeadline} WHERE id = '90000000-0000-4000-8000-000000000005'`;
    await sql`SELECT * FROM public.complete_private_media_cleanup(${finalizeRaceLease}, ARRAY['90000000-0000-4000-8000-000000000005']::uuid[])`;
    const [raceResidue] = await sql<{ sessions: number; consents: number }[]>`
      SELECT
        (SELECT count(*)::int FROM private_media_upload_sessions WHERE id IN ('90000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000005')) AS sessions,
        (SELECT count(*)::int FROM private_media_consents WHERE session_id IN ('90000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000005')) AS consents
    `;
    if (raceResidue?.sessions !== 0 || raceResidue.consents !== 0) {
      throw new Error(`Cleanup race left orphaned media rows: ${JSON.stringify(raceResidue)}.`);
    }
    await sql`
      INSERT INTO private_media_upload_sessions
        (id, public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
          claimed_extension, claimed_bytes, status, capability_nonce_hash, capability_expires_at,
          finalize_capability_expires_at, finalized_at, terminal_error_code,
          processing_lease_token, processing_lease_expires_at)
      VALUES
        ('90000000-0000-4000-8000-000000000006', 'media_ffffffffffffffffffffffffffffffff', ${mediaPrimary.intakeId}, 'missing_part', 'broken_part_context',
          'quarantine/ff/ffffffffffffffffffffffff', 'image/jpeg', 'jpg', 100, 'rejected', ${"f".repeat(64)},
          ${mediaPastDeadline}, ${mediaPastDeadline}, pg_catalog.clock_timestamp(), 'MEDIA_QUARANTINE_DELETE_PENDING|MEDIA_TYPE_MISMATCH', NULL, NULL),
        ('90000000-0000-4000-8000-000000000007', 'media_gggggggggggggggggggggggggggggggg', ${mediaAlias.intakeId}, 'missing_part', 'installed_fit',
          'quarantine/aa/gggggggggggggggggggggggg', 'image/jpeg', 'jpg', 100, 'processing', ${"1".repeat(64)},
          ${mediaPastDeadline}, ${mediaPastDeadline}, NULL, NULL,
          '90000000-0000-4000-8000-000000000020', pg_catalog.clock_timestamp() - interval '1 second')
    `;
    await sql`
      INSERT INTO private_media_consents
        (session_id, intake_id, owns_or_has_permission, private_storage_consent, derivative_processing_consent,
          public_display_consent, terms_version, privacy_version, retention_version, accepted_at, retention_deadline)
      VALUES
        ('90000000-0000-4000-8000-000000000006', ${mediaPrimary.intakeId}, true, true, true, false,
          'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture}),
        ('90000000-0000-4000-8000-000000000007', ${mediaAlias.intakeId}, true, true, true, false,
          'test-terms-v1', 'test-privacy-v1', 'test-retention-v1', ${mediaNow}, ${mediaFuture})
    `;
    const quarantineRecoveryLease = "90000000-0000-4000-8000-000000000021";
    const quarantineRecoveryClaim = await sql<{ sessionId: string }[]>`
      SELECT session_id AS "sessionId" FROM public.claim_private_media_quarantine_cleanup(10, ${quarantineRecoveryLease})
    `;
    if (quarantineRecoveryClaim.map((row) => row.sessionId).sort().join(",")
      !== ["90000000-0000-4000-8000-000000000006", "90000000-0000-4000-8000-000000000007"].join(",")) {
      throw new Error(`Quarantine recovery did not claim rejection/storage-failure and expired processing leases: ${JSON.stringify(quarantineRecoveryClaim)}.`);
    }
    await sql`UPDATE private_media_upload_sessions SET processing_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes' WHERE id = '90000000-0000-4000-8000-000000000007'`;
    let quarantineRevalidationRejected = false;
    try {
      await sql`SELECT public.complete_private_media_quarantine_cleanup(${quarantineRecoveryLease}, ${quarantineRecoveryClaim.map((row) => row.sessionId)}::uuid[])`;
    } catch (error) { quarantineRevalidationRejected = hasDatabaseErrorCode(error, "55000"); }
    if (!quarantineRevalidationRejected) throw new Error("Quarantine recovery completion did not revalidate an active processing lease.");
    await sql`UPDATE private_media_upload_sessions SET processing_lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' WHERE id = '90000000-0000-4000-8000-000000000007'`;
    await sql`SELECT public.complete_private_media_quarantine_cleanup(${quarantineRecoveryLease}, ${quarantineRecoveryClaim.map((row) => row.sessionId)}::uuid[])`;
    const recoveredQuarantine = await sql<{ cleanupLease: string | null; error: string | null; processingLease: string | null; status: string }[]>`
      SELECT cleanup_lease_token AS "cleanupLease", terminal_error_code AS error,
        processing_lease_token AS "processingLease", status
      FROM private_media_upload_sessions
      WHERE id IN ('90000000-0000-4000-8000-000000000006','90000000-0000-4000-8000-000000000007')
      ORDER BY id
    `;
    if (recoveredQuarantine.length !== 2
      || recoveredQuarantine[0]?.status !== "rejected" || recoveredQuarantine[0].error !== "MEDIA_TYPE_MISMATCH"
      || recoveredQuarantine[1]?.status !== "rejected" || recoveredQuarantine[1].error !== "MEDIA_PROCESSING_LEASE_EXPIRED"
      || recoveredQuarantine.some((row) => row.cleanupLease !== null || row.processingLease !== null)) {
      throw new Error(`Quarantine recovery did not preserve rejection or close an abandoned processing lease: ${JSON.stringify(recoveredQuarantine)}.`);
    }
    await sql`
      INSERT INTO private_media_pending_objects (id, session_id, kind, object_path, delete_after)
      VALUES
        ('90000000-0000-4000-8000-000000000030', '90000000-0000-4000-8000-000000000006', 'sanitized_master',
          ${`private/aa/media_ffffffffffffffffffffffffffffffff/master-${"2".repeat(64)}.webp`}, pg_catalog.clock_timestamp() - interval '1 second'),
        ('90000000-0000-4000-8000-000000000031', '90000000-0000-4000-8000-000000000007', 'thumbnail',
          ${`private/bb/media_gggggggggggggggggggggggggggggggg/thumbnail-${"3".repeat(64)}.webp`}, pg_catalog.clock_timestamp() - interval '1 second')
    `;
    const pendingObjectLease = "90000000-0000-4000-8000-000000000032";
    const pendingObjectClaim = await sql<{ pendingObjectId: string }[]>`
      SELECT pending_object_id AS "pendingObjectId"
      FROM public.claim_private_media_pending_object_cleanup(10, ${pendingObjectLease})
    `;
    if (pendingObjectClaim.map((row) => row.pendingObjectId).sort().join(",")
      !== ["90000000-0000-4000-8000-000000000030", "90000000-0000-4000-8000-000000000031"].join(",")) {
      throw new Error(`Pending-object cleanup did not claim every uncommitted derivative: ${JSON.stringify(pendingObjectClaim)}.`);
    }
    await sql`
      UPDATE private_media_upload_sessions SET status = 'processing',
        processing_lease_token = '90000000-0000-4000-8000-000000000033',
        processing_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes'
      WHERE id = '90000000-0000-4000-8000-000000000007'
    `;
    let pendingCompletionRevalidated = false;
    try {
      await sql`SELECT public.complete_private_media_pending_object_cleanup(${pendingObjectLease}, ${pendingObjectClaim.map((row) => row.pendingObjectId)}::uuid[])`;
    } catch (error) { pendingCompletionRevalidated = hasDatabaseErrorCode(error, "55000"); }
    if (!pendingCompletionRevalidated) throw new Error("Pending-object cleanup completion did not revalidate active processing.");
    await sql`
      UPDATE private_media_upload_sessions SET status = 'rejected', processing_lease_token = NULL,
        processing_lease_expires_at = NULL WHERE id = '90000000-0000-4000-8000-000000000007'
    `;
    await sql`SELECT public.complete_private_media_pending_object_cleanup(${pendingObjectLease}, ${pendingObjectClaim.map((row) => row.pendingObjectId)}::uuid[])`;
    const [pendingResidue] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM private_media_pending_objects`;
    if (pendingResidue?.count !== 0) throw new Error(`Pending-object cleanup left manifest residue: ${JSON.stringify(pendingResidue)}.`);
    let bindingKindMismatchRejected = false;
    try {
      await sql`
        UPDATE submission_idempotency_bindings
        SET kind = 'design_submission'
        WHERE submission_id = ${createdSubmission.id}
      `;
    } catch (error) {
      bindingKindMismatchRejected = hasDatabaseErrorCode(error, "55000");
    }
    const [bindingSchema] = await sql<{
      foreignKey: string;
      primaryKey: string;
      scopeIndex: string;
      submissionIndex: string;
      versionCheck: string;
      redundantSubmissionColumns: number;
    }[]>`
      SELECT
        pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conname = 'submission_idempotency_bindings_pkey')) AS "primaryKey",
        pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conname = 'submission_idempotency_bindings_submission_contract_fk')) AS "foreignKey",
        pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conname = 'submission_idempotency_bindings_intake_version_ck')) AS "versionCheck",
        (SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'submission_idempotency_bindings_submission_idx') AS "submissionIndex",
        (SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'submission_idempotency_bindings_scope_uq') AS "scopeIndex",
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'submissions'
            AND column_name IN ('idempotency_actor_key', 'idempotency_key_hash', 'request_fingerprint')) AS "redundantSubmissionColumns"
    `;
    if (
      !bindingKindMismatchRejected
      || !bindingSchema
      || bindingSchema.primaryKey !== "PRIMARY KEY (id)"
      || !bindingSchema.scopeIndex.includes("(kind, idempotency_actor_key, idempotency_key_hash)")
      || !bindingSchema.foreignKey.includes("FOREIGN KEY (submission_id, kind, intake_version, hmac_version, receipt_id) REFERENCES submissions(id, kind, intake_version, hmac_version, receipt_id) ON DELETE RESTRICT")
      || !bindingSchema.versionCheck.includes("CHECK ((intake_version = 1))")
      || !bindingSchema.submissionIndex.includes("(submission_id, accepted_at, id)")
      || bindingSchema.redundantSubmissionColumns !== 0
    ) {
      throw new Error(`Durable idempotency binding integrity is not enforced: ${JSON.stringify(bindingSchema)}.`);
    }
    const [legacyBindingTarget] = await database
      .insert(schema.submissions)
      .values({ kind: "missing_part", payload: { brand: "Legacy binding rejection fixture" } })
      .returning({ id: schema.submissions.id, receiptId: schema.submissions.receiptId });
    if (!legacyBindingTarget) throw new Error("Legacy binding rejection fixture was not created.");
    let legacyBindingRejected = false;
    try {
      await sql`
        INSERT INTO submission_idempotency_bindings (
          kind, idempotency_actor_key, idempotency_key_hash, submission_id, receipt_id,
          intake_version, hmac_version, request_fingerprint, payload, privacy_consent,
          contribution_consent, email_follow_up_consent, contributor_terms_version,
          privacy_notice_version, contact_consent_version, retention_policy_version,
          accepted_at, challenge_provider, challenge_verified_at, contact_present,
          contact_digest, retention_expires_at, contact_retention_expires_at
        ) VALUES (
          'missing_part',
          ${fixtureDigest("legacy-binding-actor")},
          ${fixtureDigest("legacy-binding-key")},
          ${legacyBindingTarget.id},
          ${legacyBindingTarget.receiptId},
          1,
          ${SUBMISSION_HMAC_ALGORITHM_VERSION},
          ${fixtureDigest("legacy-binding-request")},
          ${JSON.stringify({ brand: "Legacy binding rejection fixture" })}::jsonb,
          true,
          true,
          false,
          ${CONTRIBUTOR_TERMS_VERSION},
          ${PRIVACY_NOTICE_VERSION},
          ${CONTACT_CONSENT_VERSION},
          'wp08-database-fixture-v1',
          CURRENT_TIMESTAMP,
          'turnstile',
          CURRENT_TIMESTAMP,
          false,
          NULL,
          CURRENT_TIMESTAMP + INTERVAL '1 day',
          NULL
        )
      `;
    } catch (error) {
      legacyBindingRejected = hasDatabaseErrorCode(error, "23503");
    }
    let legacyPromotionRejected = false;
    try {
      await sql`
        UPDATE submissions
        SET intake_version = 1,
            hmac_version = ${SUBMISSION_HMAC_ALGORITHM_VERSION},
            contributor_key = ${fixtureDigest("legacy-promotion-contributor")},
            content_fingerprint = ${fixtureDigest("legacy-promotion-content")}
        WHERE id = ${legacyBindingTarget.id}
      `;
    } catch (error) {
      legacyPromotionRejected = hasDatabaseErrorCode(error, "23514");
    }
    await database.delete(schema.submissions).where(eq(schema.submissions.id, legacyBindingTarget.id));
    if (!legacyBindingRejected || !legacyPromotionRejected) {
      throw new Error("A legacy parent crossed into the immutable intake graph without a complete binding.");
    }
    const idempotencyLookup = await submissionRepository.findAnonymousSubmissionIdempotency({
      idempotencyActorKey: fixtureDigest(baseSubmission.idempotencyActorKey),
      idempotencyKeyHash: fixtureDigest(baseSubmission.idempotencyKeyHash),
      kind: baseSubmission.kind,
    }, database);
    const crossActorLookup = await submissionRepository.findAnonymousSubmissionIdempotency({
      idempotencyActorKey: fixtureDigest("unrelated-actor"),
      idempotencyKeyHash: fixtureDigest(baseSubmission.idempotencyKeyHash),
      kind: baseSubmission.kind,
    }, database);
    if (
      idempotencyLookup?.receiptId !== createdSubmission.receiptId
      || idempotencyLookup.requestFingerprint !== fixtureDigest(baseSubmission.requestFingerprint)
      || crossActorLookup !== null
      || "id" in (idempotencyLookup ?? {})
    ) {
      throw new Error("Actor-scoped idempotency lookup returned an unsafe or cross-actor result.");
    }

    const contentDuplicate = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      idempotencyKeyHash: "idempotency-b".padEnd(64, "0"),
    }, database);
    if (!contentDuplicate.duplicate || contentDuplicate.id !== createdSubmission.id) {
      throw new Error("Same-contributor active content was not deduplicated atomically.");
    }
    const contentDuplicateReplay = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      idempotencyKeyHash: "idempotency-b".padEnd(64, "0"),
    }, database);
    let contentDuplicateChangedContactRejected = false;
    try {
      await submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contactEmail: "changed-semantic-alias@example.invalid",
        idempotencyKeyHash: "idempotency-b".padEnd(64, "0"),
        requestFingerprint: "request-b-changed-contact".padEnd(64, "0"),
      }, database);
    } catch (error) {
      contentDuplicateChangedContactRejected = error instanceof Error
        && error.name === "SubmissionIdempotencyConflictError";
    }
    const [semanticAliasEvidence] = await sql<{ bindings: number; submissions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions WHERE id = ${createdSubmission.id}) AS submissions,
        (SELECT count(*)::int FROM submission_idempotency_bindings
          WHERE submission_id = ${createdSubmission.id}) AS bindings
    `;
    if (
      !contentDuplicateReplay.duplicate
      || contentDuplicateReplay.receiptId !== createdSubmission.receiptId
      || !contentDuplicateChangedContactRejected
      || semanticAliasEvidence?.submissions !== 1
      || semanticAliasEvidence.bindings !== 2
    ) {
      throw new Error("A semantic duplicate key was not durably bound to one logical submission and receipt.");
    }

    const independentSubmission = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactEmail: undefined,
      contributorKey: "contributor-b".padEnd(64, "0"),
      idempotencyActorKey: "actor-b".padEnd(64, "0"),
      idempotencyKeyHash: "idempotency-c".padEnd(64, "0"),
      requestFingerprint: "request-independent".padEnd(64, "0"),
    }, database);
    if (independentSubmission.duplicate || independentSubmission.id === createdSubmission.id) {
      throw new Error("An independent contributor's evidence was incorrectly collapsed by content deduplication.");
    }

    const actorScopedIdempotency = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contributorKey: "contributor-c".padEnd(64, "0"),
      idempotencyActorKey: "actor-c".padEnd(64, "0"),
      requestFingerprint: "request-scoped-idempotency".padEnd(64, "0"),
    }, database);
    if (
      actorScopedIdempotency.duplicate
      || actorScopedIdempotency.id === createdSubmission.id
      || actorScopedIdempotency.receiptId === createdSubmission.receiptId
    ) {
      throw new Error("A different actor collided with another actor's idempotency key.");
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
      idempotencyActorKey: "different-contact-actor".padEnd(64, "0"),
      requestFingerprint: "request-different-contact".padEnd(64, "0"),
    }, database);
    if (changedContributorContact.duplicate || changedContributorContact.id === createdSubmission.id) {
      throw new Error("A different contributor collided through another contributor's idempotency key.");
    }
    const originalContacts = await sql<{ contactEmail: string; followUps: number }[]>`
      SELECT contact.contact_email AS "contactEmail",
        (SELECT count(*)::int FROM submission_email_follow_ups AS follow_up
          WHERE follow_up.intake_id = intake.id) AS "followUps"
      FROM submission_intake_contacts AS contact
      INNER JOIN submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
      WHERE intake.submission_id IN (${createdSubmission.id}, ${changedContributorContact.id})
      ORDER BY contact.contact_email
    `;
    const originalContactCount = originalContacts.filter(
      (row) => row.contactEmail === baseSubmission.contactEmail,
    ).length;
    const independentContactCount = originalContacts.filter(
      (row) => row.contactEmail === "different-private@example.invalid",
    ).length;
    if (
      originalContacts.length !== 3
      || originalContacts.some((row) => row.followUps !== 0)
      || originalContactCount !== 2
      || independentContactCount !== 1
    ) {
      throw new Error("Actor-scoped idempotency overwrote private contact or created email work during intake.");
    }

    const outcomeSubmissions = await Promise.all([
      submissionRepository.persistAnonymousSubmission({
        ...baseSubmission,
        contentFingerprint: "print-failed".padEnd(64, "0"),
        contributorKey: "outcome-reporter".padEnd(64, "0"),
        idempotencyActorKey: "outcome-reporter-actor".padEnd(64, "0"),
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
        idempotencyActorKey: "outcome-reporter-actor".padEnd(64, "0"),
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
      || serializedQueue.includes(fixtureDigest(baseSubmission.contributorKey))
      || serializedQueue.includes(fixtureDigest(baseSubmission.idempotencyActorKey))
      || serializedQueue.includes(fixtureDigest(baseSubmission.idempotencyKeyHash))) {
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
      createdSubmission.intakeId,
      { eventId: "00000000-0000-4000-8000-000000000501", kind: "matching_publication" },
      database,
    );
    const retriggered = await submissionRepository.triggerSubmissionEmailFollowUp(
      createdSubmission.intakeId,
      { eventId: "00000000-0000-4000-8000-000000000501", kind: "matching_publication" },
      database,
    );
    const pinnedFollowUpSecret = process.env.SUBMISSION_HMAC_SECRET;
    let mismatchedPinFollowUpRejected = false;
    let mismatchedFollowUpSecret = generateSubmissionTestHmacSecret();
    while (mismatchedFollowUpSecret === pinnedFollowUpSecret) {
      mismatchedFollowUpSecret = generateSubmissionTestHmacSecret();
    }
    process.env.SUBMISSION_HMAC_SECRET = mismatchedFollowUpSecret;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        createdSubmission.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000510", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      mismatchedPinFollowUpRejected = error instanceof Error
        && "code" in error
        && error.code === "SUBMISSION_UNAVAILABLE";
    } finally {
      process.env.SUBMISSION_HMAC_SECRET = pinnedFollowUpSecret;
    }
    const [triggeredFollowUp] = await sql<{ count: number; total: number }[]>`
      SELECT count(*)::int AS count,
        (SELECT count(*)::int FROM submission_email_follow_ups
          WHERE submission_id = ${createdSubmission.id}) AS total
      FROM submission_email_follow_ups
      WHERE id = ${triggered.followUpId}
        AND intake_id = ${createdSubmission.intakeId}
        AND submission_id = ${createdSubmission.id}
        AND status = 'pending'
        AND available_at <= CURRENT_TIMESTAMP
    `;
    if (
      triggered.duplicate
      || !retriggered.duplicate
      || triggered.followUpId !== retriggered.followUpId
      || triggeredFollowUp?.count !== 1
      || triggeredFollowUp.total !== 1
      || !mismatchedPinFollowUpRejected
    ) {
      throw new Error("A qualifying follow-up was not exact-once or bypassed the pinned HMAC boundary.");
    }
    let invalidEventIdRejected = false;
    try {
        await submissionRepository.triggerSubmissionEmailFollowUp(
        createdSubmission.intakeId,
        { eventId: "client-chosen-label", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      invalidEventIdRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_EVENT_INVALID";
    }
    let mismatchedEventRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        outcomeSubmissions[0]!.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000504", kind: "matching_publication" },
        database,
      );
    } catch (error) {
      mismatchedEventRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!invalidEventIdRejected || !mismatchedEventRejected) {
      throw new Error("Follow-up creation accepted an unqualified event ID or a kind/submission mismatch.");
    }
    const obsoleteConsentIntake = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      contactConsentVersion: "obsolete-consent-version",
      contentFingerprint: "obsolete-consent-content".padEnd(64, "0"),
      contributorKey: "obsolete-consent-contributor".padEnd(64, "0"),
      idempotencyActorKey: "obsolete-consent-actor".padEnd(64, "0"),
      idempotencyKeyHash: "obsolete-consent-key".padEnd(64, "0"),
      requestFingerprint: "obsolete-consent-request".padEnd(64, "0"),
    }, database);
    let obsoleteConsentRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        obsoleteConsentIntake.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000507", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      obsoleteConsentRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
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
          idempotencyActorKey: "concurrent-actor".padEnd(64, "0"),
          idempotencyKeyHash: `concurrent-${index}`.padEnd(64, "0"),
          requestFingerprint: "concurrent-request".padEnd(64, "0"),
        }, concurrencyDatabase)));
      if (new Set(concurrentResults.map((result) => result.id)).size !== 1
        || new Set(concurrentResults.map((result) => result.receiptId)).size !== 1
        || concurrentResults.filter((result) => !result.duplicate).length !== 1) {
        throw new Error("Concurrent same-contributor duplicates created more than one active queue row.");
      }
      const [concurrentPersistence] = await sql<{ bindings: number; followUps: number; submissions: number }[]>`
        SELECT
          (SELECT count(*)::int FROM submissions
            WHERE contributor_key = ${fixtureDigest("concurrent-contributor".padEnd(64, "0"))}
              AND content_fingerprint = ${fixtureDigest("concurrent-content".padEnd(64, "0"))}) AS submissions,
          (SELECT count(*)::int FROM submission_idempotency_bindings
            WHERE submission_id = ${concurrentResults[0]!.id}) AS bindings,
          (SELECT count(*)::int FROM submission_email_follow_ups
            WHERE submission_id = ${concurrentResults[0]!.id}) AS "followUps"
      `;
      if (
        concurrentPersistence?.submissions !== 1
        || concurrentPersistence.bindings !== 8
        || concurrentPersistence.followUps !== 0
      ) {
        throw new Error("Concurrent semantic deduplication did not atomically bind every key to one submission.");
      }

      const concurrentIdempotentResults = await Promise.all(Array.from({ length: 8 }, () =>
        submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: undefined,
          contactRetentionExpiresAt: undefined,
          contentFingerprint: "concurrent-key-content".padEnd(64, "0"),
          contributorKey: "concurrent-key-contributor".padEnd(64, "0"),
          idempotencyActorKey: "concurrent-key-actor".padEnd(64, "0"),
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
      const [concurrentIdempotentBindings] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM submission_idempotency_bindings
        WHERE submission_id = ${concurrentIdempotentResults[0]!.id}
          AND idempotency_actor_key = ${fixtureDigest("concurrent-key-actor".padEnd(64, "0"))}
          AND idempotency_key_hash = ${fixtureDigest("concurrent-same-idempotency".padEnd(64, "0"))}
      `;
      if (concurrentIdempotentBindings?.count !== 1) {
        throw new Error("Concurrent exact retries created more than one durable binding.");
      }

      const racingActorKey = fixtureDigest("concurrent-conflict-actor".padEnd(64, "0"));
      const racingIdempotencyKeyHash = fixtureDigest("concurrent-conflict-key".padEnd(64, "0"));
      const racingResults = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
        submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: undefined,
          contactRetentionExpiresAt: undefined,
          contentFingerprint: `concurrent-conflict-content-${index}`.padEnd(64, "0"),
          contributorKey: "concurrent-conflict-contributor".padEnd(64, "0"),
          idempotencyActorKey: racingActorKey,
          idempotencyKeyHash: racingIdempotencyKeyHash,
          payload: { ...baseSubmission.payload, brokenPart: `Racing component ${index}` },
          requestFingerprint: `concurrent-conflict-request-${index}`.padEnd(64, "0"),
        }, concurrencyDatabase)));
      const racingSuccesses = racingResults.filter((result) => result.status === "fulfilled");
      const racingFailures = racingResults.filter((result) => result.status === "rejected");
      const [racingPersistence] = await sql<{ bindings: number; submissions: number; unbound: number }[]>`
        SELECT
          (SELECT count(*)::int FROM submission_idempotency_bindings
            WHERE kind = 'missing_part'
              AND idempotency_actor_key = ${racingActorKey}
              AND idempotency_key_hash = ${racingIdempotencyKeyHash}) AS bindings,
          (SELECT count(*)::int FROM submissions
            WHERE contributor_key = ${fixtureDigest("concurrent-conflict-contributor".padEnd(64, "0"))}) AS submissions,
          (SELECT count(*)::int FROM submissions AS submission
            WHERE submission.contributor_key = ${fixtureDigest("concurrent-conflict-contributor".padEnd(64, "0"))}
              AND NOT EXISTS (SELECT 1 FROM submission_idempotency_bindings AS binding
                WHERE binding.submission_id = submission.id)) AS unbound
      `;
      if (
        racingSuccesses.length !== 1
        || racingFailures.length !== 7
        || racingFailures.some((result) => !(result.reason instanceof Error)
          || result.reason.name !== "SubmissionIdempotencyConflictError")
        || racingPersistence?.bindings !== 1
        || racingPersistence.submissions !== 1
        || racingPersistence.unbound !== 0
      ) {
        throw new Error("Concurrent changed-payload retries did not deterministically commit one actor-scoped row.");
      }

      const restartClient = postgres(databaseUrl, { prepare: false, max: 1 });
      try {
        const restartDatabase = drizzle(restartClient, { schema });
        const persistedWinner = racingSuccesses[0]?.value;
        const restartedLookup = await submissionRepository.findAnonymousSubmissionIdempotency({
          idempotencyActorKey: racingActorKey,
          idempotencyKeyHash: racingIdempotencyKeyHash,
          kind: "missing_part",
        }, restartDatabase);
        if (
          !persistedWinner
          || restartedLookup?.receiptId !== persistedWinner.receiptId
          || restartedLookup.requestFingerprint !== persistedWinner.requestFingerprint
        ) {
          throw new Error("A fresh database connection could not recover the committed idempotency receipt.");
        }
      } finally {
        await restartClient.end();
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

      const rollbackIdempotency = fixtureDigest("rollback-idempotency".padEnd(64, "0"));
      let retentionRollbackObserved = false;
      try {
        await submissionRepository.persistAnonymousSubmission({
          ...baseSubmission,
          contactEmail: "rollback-private@example.invalid",
          contentFingerprint: "rollback-content".padEnd(64, "0"),
          contributorKey: "rollback-contributor".padEnd(64, "0"),
          idempotencyActorKey: "rollback-actor".padEnd(64, "0"),
          idempotencyKeyHash: rollbackIdempotency,
          retentionExpiresAt: consentedAt,
          requestFingerprint: "rollback-request".padEnd(64, "0"),
        }, concurrencyDatabase);
      } catch {
        retentionRollbackObserved = true;
      }
      const [rolledBackSubmission] = await sql<{ bindings: number; submissions: number }[]>`
        SELECT
          (SELECT count(*)::int FROM submission_idempotency_bindings
            WHERE idempotency_key_hash = ${rollbackIdempotency}) AS bindings,
          (SELECT count(*)::int FROM submissions
            WHERE content_fingerprint = ${fixtureDigest("rollback-content".padEnd(64, "0"))}) AS submissions
      `;
      if (
        !retentionRollbackObserved
        || rolledBackSubmission?.bindings !== 0
        || rolledBackSubmission.submissions !== 0
      ) {
        throw new Error("An invalid retention contract did not fail closed without a private submission.");
      }
    } finally {
      await concurrencyClient.end();
    }

    const handlerEnvironment = { ...process.env };
    process.env.DEMO_MODE = "false";
    process.env.NEXT_PUBLIC_SITE_URL = "https://repairprint.example";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "wp08-database-public-turnstile-fixture";
    process.env.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-handler-policy-v1";
    process.env.SUBMISSION_RETENTION_DAYS = "90";
    process.env.SUBMISSION_CONTACT_RETENTION_DAYS = "30";
    process.env.TURNSTILE_SECRET_KEY = "wp08-database-private-turnstile-fixture";
    process.env.VERCEL = "1";
    const handlerConfig = Object.freeze({
      kind: "missing_part" as const,
      returnPath: "/request-part",
      structuralSchema: missingPartRequestIntakeStructuralSchema,
      turnstileAction: "missing_part",
    });
    const realHandlerPersistence = (handlerDatabase: typeof database): AnonymousSubmissionPersistence => Object.freeze({
      verifyHmacKeyPin: () => submissionRepository.verifySubmissionHmacKeyPin(handlerDatabase),
      consumeRateLimits: (buckets, now) =>
        submissionRepository.consumeSubmissionRateLimitBuckets(buckets, now, handlerDatabase),
      findIdempotency: (input) =>
        submissionRepository.findAnonymousSubmissionIdempotency(input, handlerDatabase),
      persist: (input) => submissionRepository.persistAnonymousSubmission(input, handlerDatabase),
    });
    const handlerDependencies = (
      handlerDatabase: typeof database,
      requestTime: Date,
    ): SubmissionApiDependencies => Object.freeze({
      createReceiptId: () => "00000000-0000-4000-8000-0000000005ff",
      getPersistence: async () => realHandlerPersistence(handlerDatabase),
      now: () => requestTime,
      resolveClientIp: trustedSubmissionClientIp,
      verifyChallenge: async (input) => {
        if (
          input.action !== "missing_part"
          || !input.token.startsWith("db-handler-turnstile-")
          || (!input.clientIp.startsWith("203.0.113.") && input.clientIp !== "2001:db8::1")
        ) {
          throw new Error("Unexpected handler Turnstile boundary input.");
        }
      },
    });
    const handlerRequest = (
      payload: Readonly<Record<string, unknown>>,
      clientIp: string,
    ): NextRequest => new NextRequest("https://repairprint.example/api/v1/submissions/requests", {
      body: JSON.stringify(payload),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://repairprint.example",
        "x-forwarded-for": "198.51.100.250",
        "x-vercel-forwarded-for": clientIp,
      },
      method: "POST",
    });
    try {
      const handlerNow = new Date("2026-07-12T14:00:00.000Z");
      const handlerFixture = Object.freeze({
        brand: "WP08 handler fixture",
        brokenPart: "Restart-safe latch",
        challengeToken: "db-handler-turnstile-initial",
        contributionConsent: true,
        emailFollowUpConsent: true,
        idempotencyKey: "00000000-0000-4000-8000-000000000601",
        modelNumber: "HANDLER-IDEM-100",
        notes: "Private real-handler database fixture",
        oemPartNumber: "",
        privacyConsent: true,
        website: "",
      });
      const concurrentHandlerResponses = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        handleAnonymousSubmission(
          handlerRequest({
            ...handlerFixture,
            challengeToken: `db-handler-turnstile-identical-${index}`,
          }, "203.0.113.80"),
          handlerConfig,
          handlerDependencies(database, handlerNow),
        )));
      const concurrentHandlerBodies = await Promise.all(concurrentHandlerResponses.map((response) => response.json())) as Array<{
        id?: string;
      }>;
      const [handlerPersistence] = await sql<{ count: number; receipts: number }[]>`
        SELECT count(*)::int AS count, count(DISTINCT receipt_id)::int AS receipts
        FROM submissions
        WHERE intake_version = 1 AND payload->>'modelNumber' = 'HANDLER-IDEM-100'
      `;
      if (
        concurrentHandlerResponses.some((response) => response.status !== 202)
        || new Set(concurrentHandlerBodies.map((body) => body.id)).size !== 1
        || handlerPersistence?.count !== 1
        || handlerPersistence.receipts !== 1
      ) {
        throw new Error("Real handler concurrent identical retries did not persist one stable receipt.");
      }

      const restartClient = postgres(databaseUrl, { prepare: false, max: 1 });
      try {
        const restartDatabase = drizzle(restartClient, { schema });
        const restartResponse = await handleAnonymousSubmission(
          handlerRequest({
            ...handlerFixture,
            challengeToken: "db-handler-turnstile-after-restart",
          }, "203.0.113.80"),
          handlerConfig,
          handlerDependencies(restartDatabase, new Date("2026-07-12T14:11:00.000Z")),
        );
        const restartBody = await restartResponse.json() as { id?: string };
        if (restartResponse.status !== 202 || restartBody.id !== concurrentHandlerBodies[0]?.id) {
          throw new Error("Real handler retry lost its database receipt across a fresh connection restart.");
        }
      } finally {
        await restartClient.end();
      }

      process.env.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-handler-policy-v2";
      const policyMismatchResponse = await handleAnonymousSubmission(
        handlerRequest({
          ...handlerFixture,
          challengeToken: "db-handler-turnstile-policy-change",
        }, "203.0.113.80"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T14:22:00.000Z")),
      );
      const policyMismatchBody = await policyMismatchResponse.json() as { error?: { code?: string } };
      const [policyMismatchRows] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM submissions
        WHERE intake_version = 1 AND payload->>'modelNumber' = 'HANDLER-IDEM-100'
      `;
      if (
        policyMismatchResponse.status !== 409
        || policyMismatchBody.error?.code !== "IDEMPOTENCY_KEY_REUSED"
        || policyMismatchRows?.count !== 1
      ) {
        throw new Error("A policy-version change reused an actor idempotency key or changed its row count.");
      }
      process.env.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-handler-policy-v1";

      const contactRaceIdempotency = "00000000-0000-4000-8000-000000000602";
      const contactRaceFixtures = [
        { email: undefined, emailFollowUpConsent: false },
        { email: undefined, emailFollowUpConsent: true },
        { email: "handler-race-a@example.invalid", emailFollowUpConsent: true },
        { email: "handler-race-b@example.invalid", emailFollowUpConsent: true },
      ] as const;
      const contactRaceResponses = await Promise.all(contactRaceFixtures.map((variant, index) =>
        handleAnonymousSubmission(
          handlerRequest({
            brand: "WP08 handler fixture",
            brokenPart: "Contact-race latch",
            challengeToken: `db-handler-turnstile-contact-race-${index}`,
            contributionConsent: true,
            email: variant.email,
            emailFollowUpConsent: variant.emailFollowUpConsent,
            idempotencyKey: contactRaceIdempotency,
            modelNumber: "HANDLER-RACE-100",
            notes: "Private contact/consent race fixture",
            oemPartNumber: "",
            privacyConsent: true,
            website: "",
          }, "203.0.113.81"),
          handlerConfig,
          handlerDependencies(database, new Date("2026-07-12T15:00:00.000Z")),
        )));
      const contactRaceBodies = await Promise.all(contactRaceResponses.map((response) => response.json())) as Array<{
        error?: { code?: string };
      }>;
      const [contactRacePersistence] = await sql<{
        bindings: number;
        contactEmail: string | null;
        distinctActors: number;
        distinctReceipts: number;
        followUps: number;
        orphanBindings: number;
        submissions: number;
        unboundSubmissions: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM submissions
            WHERE intake_version = 1 AND payload->>'modelNumber' = 'HANDLER-RACE-100') AS submissions,
          (SELECT max(contact.contact_email)
            FROM submission_intake_contacts AS contact
            INNER JOIN submission_idempotency_bindings AS binding ON binding.id = contact.intake_id
            INNER JOIN submissions AS submission ON submission.id = binding.submission_id
            WHERE submission.intake_version = 1
              AND submission.payload->>'modelNumber' = 'HANDLER-RACE-100') AS "contactEmail",
          (SELECT count(*)::int FROM submission_idempotency_bindings AS binding
            INNER JOIN submissions AS submission ON submission.id = binding.submission_id
            WHERE submission.payload->>'modelNumber' = 'HANDLER-RACE-100') AS bindings,
          (SELECT count(DISTINCT binding.idempotency_actor_key)::int
            FROM submission_idempotency_bindings AS binding
            INNER JOIN submissions AS submission ON submission.id = binding.submission_id
            WHERE submission.payload->>'modelNumber' = 'HANDLER-RACE-100') AS "distinctActors",
          (SELECT count(DISTINCT receipt_id)::int FROM submissions
            WHERE payload->>'modelNumber' = 'HANDLER-RACE-100') AS "distinctReceipts",
          (SELECT count(*)::int FROM submission_email_follow_ups AS follow_up
            INNER JOIN submissions AS submission ON submission.id = follow_up.submission_id
            WHERE submission.payload->>'modelNumber' = 'HANDLER-RACE-100') AS "followUps",
          (SELECT count(*)::int FROM submissions AS submission
            WHERE submission.intake_version = 1
              AND NOT EXISTS (SELECT 1 FROM submission_idempotency_bindings AS binding
                WHERE binding.submission_id = submission.id)) AS "unboundSubmissions",
          (SELECT count(*)::int FROM submission_idempotency_bindings AS binding
            LEFT JOIN submissions AS submission
              ON submission.id = binding.submission_id AND submission.kind = binding.kind
            WHERE submission.id IS NULL) AS "orphanBindings"
      `;
      const allowedContactRaceWinners = new Set<string | null>([
        null,
        "handler-race-a@example.invalid",
        "handler-race-b@example.invalid",
      ]);
      if (
        contactRaceResponses.filter((response) => response.status === 202).length !== 1
        || contactRaceResponses.filter((response) => response.status === 409).length !== 3
        || contactRaceBodies.filter((body) => body.error?.code === "IDEMPOTENCY_KEY_REUSED").length !== 3
        || contactRacePersistence?.submissions !== 1
        || contactRacePersistence.bindings !== 1
        || contactRacePersistence.distinctActors !== 1
        || contactRacePersistence.distinctReceipts !== 1
        || contactRacePersistence.followUps !== 0
        || contactRacePersistence.unboundSubmissions !== 0
        || contactRacePersistence.orphanBindings !== 0
        || !allowedContactRaceWinners.has(contactRacePersistence.contactEmail)
      ) {
        throw new Error("Real handler contact/consent races did not fail closed to one actor-scoped row.");
      }

      const semanticHandlerFixture = Object.freeze({
        brand: "WP08 handler fixture",
        brokenPart: "Semantic alias latch",
        challengeToken: "db-handler-turnstile-semantic-k1",
        contributionConsent: true,
        emailFollowUpConsent: false,
        idempotencyKey: "00000000-0000-4000-8000-000000000604",
        modelNumber: "HANDLER-SEMANTIC-100",
        notes: "Durable alias binding fixture",
        oemPartNumber: "",
        privacyConsent: true,
        website: "",
      });
      const semanticK1 = await handleAnonymousSubmission(
        handlerRequest(semanticHandlerFixture, "203.0.113.82"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T15:20:00.000Z")),
      );
      const semanticK1Body = await semanticK1.json() as { id?: string };
      const semanticK2 = await handleAnonymousSubmission(
        handlerRequest({
          ...semanticHandlerFixture,
          challengeToken: "db-handler-turnstile-semantic-k2",
          idempotencyKey: "00000000-0000-4000-8000-000000000605",
        }, "203.0.113.82"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T15:21:00.000Z")),
      );
      const semanticK2Body = await semanticK2.json() as { id?: string };
      const semanticK2Changed = await handleAnonymousSubmission(
        handlerRequest({
          ...semanticHandlerFixture,
          challengeToken: "db-handler-turnstile-semantic-k2-changed",
          email: "semantic-alias-changed@example.invalid",
          emailFollowUpConsent: true,
          idempotencyKey: "00000000-0000-4000-8000-000000000605",
        }, "203.0.113.82"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T15:22:00.000Z")),
      );
      const semanticK2ChangedBody = await semanticK2Changed.json() as { error?: { code?: string } };
      const [semanticHandlerPersistence] = await sql<{
        actors: number;
        bindings: number;
        receipts: number;
        submissions: number;
      }[]>`
        SELECT
          count(DISTINCT binding.idempotency_actor_key)::int AS actors,
          count(*)::int AS bindings,
          count(DISTINCT submission.receipt_id)::int AS receipts,
          count(DISTINCT submission.id)::int AS submissions
        FROM submissions AS submission
        INNER JOIN submission_idempotency_bindings AS binding ON binding.submission_id = submission.id
        WHERE submission.payload->>'modelNumber' = 'HANDLER-SEMANTIC-100'
      `;
      if (
        semanticK1.status !== 202
        || semanticK2.status !== 202
        || semanticK1Body.id !== semanticK2Body.id
        || semanticK2Changed.status !== 409
        || semanticK2ChangedBody.error?.code !== "IDEMPOTENCY_KEY_REUSED"
        || semanticHandlerPersistence?.actors !== 1
        || semanticHandlerPersistence.bindings !== 2
        || semanticHandlerPersistence.receipts !== 1
        || semanticHandlerPersistence.submissions !== 1
      ) {
        throw new Error("A real-handler semantic K2 alias was not durably bound before changed contact/consent replay.");
      }

      const ipv6Fixture = Object.freeze({
        brand: "WP08 handler fixture",
        brokenPart: "IPv6 idempotency latch",
        challengeToken: "db-handler-turnstile-ipv6-initial",
        contributionConsent: true,
        emailFollowUpConsent: false,
        idempotencyKey: "00000000-0000-4000-8000-000000000603",
        modelNumber: "HANDLER-IPV6-100",
        notes: "Canonical IPv6 private fixture",
        oemPartNumber: "",
        privacyConsent: true,
        website: "",
      });
      const ipv6Initial = await handleAnonymousSubmission(
        handlerRequest(ipv6Fixture, "2001:0db8:0:0:0:0:0:1"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T16:00:00.000Z")),
      );
      const ipv6InitialBody = await ipv6Initial.json() as { id?: string };
      const ipv6Replay = await handleAnonymousSubmission(
        handlerRequest({
          ...ipv6Fixture,
          challengeToken: "db-handler-turnstile-ipv6-replay",
        }, "2001:db8::1"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T16:01:00.000Z")),
      );
      const ipv6ReplayBody = await ipv6Replay.json() as { id?: string };
      const ipv6Changed = await handleAnonymousSubmission(
        handlerRequest({
          ...ipv6Fixture,
          challengeToken: "db-handler-turnstile-ipv6-changed",
          notes: "Changed IPv6 request fingerprint",
        }, "2001:db8::1"),
        handlerConfig,
        handlerDependencies(database, new Date("2026-07-12T16:02:00.000Z")),
      );
      const ipv6ChangedBody = await ipv6Changed.json() as { error?: { code?: string } };
      const [ipv6Persistence] = await sql<{ actors: number; bindings: number; submissions: number }[]>`
        SELECT
          count(DISTINCT binding.idempotency_actor_key)::int AS actors,
          count(*)::int AS bindings,
          count(DISTINCT submission.id)::int AS submissions
        FROM submissions AS submission
        INNER JOIN submission_idempotency_bindings AS binding ON binding.submission_id = submission.id
        WHERE submission.payload->>'modelNumber' = 'HANDLER-IPV6-100'
      `;
      if (
        ipv6Initial.status !== 202
        || ipv6Replay.status !== 202
        || ipv6InitialBody.id !== ipv6ReplayBody.id
        || ipv6Changed.status !== 409
        || ipv6ChangedBody.error?.code !== "IDEMPOTENCY_KEY_REUSED"
        || ipv6Persistence?.actors !== 1
        || ipv6Persistence.bindings !== 1
        || ipv6Persistence.submissions !== 1
      ) {
        throw new Error("Equivalent IPv6 spellings did not share one durable handler idempotency binding.");
      }
    } finally {
      process.env = handlerEnvironment;
    }

    await database.update(schema.submissions)
      .set({ resolvedAt: consentedAt, status: "resolved" })
      .where(eq(schema.submissions.id, createdSubmission.id));
    let resolvedFollowUpRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        createdSubmission.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000505", kind: "moderator_question" },
        database,
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

    const cleanupReference = new Date();
    const cleanupConsentedAt = new Date(cleanupReference.getTime() - 10_000);
    const fullyExpired = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      consentedAt: cleanupConsentedAt,
      challengeVerifiedAt: cleanupConsentedAt,
      contactEmail: "cleanup-delete@example.invalid",
      contactRetentionExpiresAt: new Date(cleanupReference.getTime() - 9_000),
      contentFingerprint: "cleanup-delete-content".padEnd(64, "0"),
      contributorKey: "cleanup-delete-contributor".padEnd(64, "0"),
      idempotencyActorKey: "cleanup-delete-actor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-delete-idempotency".padEnd(64, "0"),
      requestFingerprint: "cleanup-delete-request".padEnd(64, "0"),
      retentionExpiresAt: new Date(cleanupReference.getTime() - 6_000),
    }, database);
    const contactExpired = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      consentedAt: cleanupConsentedAt,
      challengeVerifiedAt: cleanupConsentedAt,
      contactEmail: "cleanup-redact@example.invalid",
      contactRetentionExpiresAt: new Date(cleanupReference.getTime() - 8_000),
      contentFingerprint: "cleanup-redact-content".padEnd(64, "0"),
      contributorKey: "cleanup-redact-contributor".padEnd(64, "0"),
      idempotencyActorKey: "cleanup-redact-actor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-redact-idempotency".padEnd(64, "0"),
      requestFingerprint: "cleanup-redact-request".padEnd(64, "0"),
      retentionExpiresAt: new Date(cleanupReference.getTime() - 3_000),
    }, database);
    const contactExpiredAlias = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      consentedAt: new Date(cleanupReference.getTime() - 2_000),
      challengeVerifiedAt: new Date(cleanupReference.getTime() - 2_000),
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      emailFollowUpConsent: false,
      contentFingerprint: "cleanup-redact-content".padEnd(64, "0"),
      contributorKey: "cleanup-redact-contributor".padEnd(64, "0"),
      idempotencyActorKey: "cleanup-redact-actor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-redact-alias-idempotency".padEnd(64, "0"),
      payload: { ...baseSubmission.payload, notes: "Late K2 private notes retained independently" },
      requestFingerprint: "cleanup-redact-alias-request".padEnd(64, "0"),
      retentionExpiresAt: new Date(cleanupReference.getTime() + 10 * 60_000),
      retentionPolicyVersion: "wp08-database-fixture-v2",
    }, database);
    if (!contactExpiredAlias.duplicate || contactExpiredAlias.id !== contactExpired.id) {
      throw new Error("Cleanup fixture did not create a second durable alias binding.");
    }
    let expiredIntakeFollowUpRejected = false;
    let expiredAliasFollowUpRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        fullyExpired.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000502", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      expiredIntakeFollowUpRejected = error instanceof Error
        && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        contactExpired.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000503", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      expiredAliasFollowUpRejected = error instanceof Error
        && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!expiredIntakeFollowUpRejected || !expiredAliasFollowUpRejected) {
      throw new Error("Database-time expiry allowed follow-up work for an expired exact intake.");
    }

    const firstCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 1);
    const secondCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 1);
    const repeatedCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 1);
    if (
      firstCleanup.deletedSubmissions !== 1
      || firstCleanup.deletedIntakes !== 1
      || firstCleanup.deletedContacts !== 1
      || secondCleanup.deletedSubmissions !== 0
      || secondCleanup.deletedIntakes !== 1
      || secondCleanup.deletedContacts !== 1
      || repeatedCleanup.deletedSubmissions !== 0
      || repeatedCleanup.deletedIntakes !== 0
      || repeatedCleanup.deletedContacts !== 0
    ) {
      throw new Error("Bounded retention cleanup was not ordered, complete, and idempotent.");
    }
    const [cleanupEvidence] = await sql<{
      deletedParent: number;
      deletedIntake: number;
      followUps: number;
      liveContacts: number;
      liveIntakes: number;
      notes: string;
      policyVersion: string;
      emailConsent: boolean;
      receiptId: string;
      requestFingerprint: string;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions WHERE id = ${fullyExpired.id}) AS "deletedParent",
        (SELECT count(*)::int FROM submission_idempotency_bindings WHERE id = ${fullyExpired.intakeId}) AS "deletedIntake",
        (SELECT count(*)::int FROM submission_email_follow_ups WHERE submission_id = ${contactExpired.id}) AS "followUps",
        (SELECT count(*)::int FROM submission_intake_contacts AS contact
          INNER JOIN submission_idempotency_bindings AS intake ON intake.id = contact.intake_id
          WHERE intake.submission_id = ${contactExpired.id}) AS "liveContacts",
        (SELECT count(*)::int FROM submission_idempotency_bindings
          WHERE submission_id = ${contactExpired.id}) AS "liveIntakes",
        intake.payload->>'notes' AS notes,
        intake.retention_policy_version AS "policyVersion",
        intake.email_follow_up_consent AS "emailConsent",
        parent.receipt_id AS "receiptId",
        intake.request_fingerprint AS "requestFingerprint"
      FROM submissions AS parent
      INNER JOIN submission_idempotency_bindings AS intake
        ON intake.submission_id = parent.id AND intake.id = ${contactExpiredAlias.intakeId}
      WHERE parent.id = ${contactExpired.id}
    `;
    if (
      !cleanupEvidence
      || cleanupEvidence.deletedParent !== 0
      || cleanupEvidence.deletedIntake !== 0
      || cleanupEvidence.followUps !== 0
      || cleanupEvidence.liveContacts !== 0
      || cleanupEvidence.liveIntakes !== 1
      || cleanupEvidence.notes !== "Late K2 private notes retained independently"
      || cleanupEvidence.policyVersion !== "wp08-database-fixture-v2"
      || cleanupEvidence.emailConsent !== false
      || cleanupEvidence.requestFingerprint !== fixtureDigest("cleanup-redact-alias-request".padEnd(64, "0"))
      || cleanupEvidence.receiptId !== contactExpired.receiptId
    ) {
      throw new Error(`Independent alias retention evidence failed: ${JSON.stringify(cleanupEvidence)}.`);
    }

    const finalAliasK1 = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: new Date(cleanupReference.getTime() - 20_000),
      consentedAt: new Date(cleanupReference.getTime() - 20_000),
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contentFingerprint: "cleanup-final-alias-content".padEnd(64, "0"),
      contributorKey: "cleanup-final-alias-contributor".padEnd(64, "0"),
      emailFollowUpConsent: false,
      idempotencyActorKey: "cleanup-final-alias-actor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-final-alias-k1".padEnd(64, "0"),
      payload: { ...baseSubmission.payload, notes: "Final-expiry K1" },
      requestFingerprint: "cleanup-final-alias-request-k1".padEnd(64, "0"),
      retentionExpiresAt: new Date(cleanupReference.getTime() - 10_000),
      retentionPolicyVersion: "wp08-database-fixture-v1",
    }, database);
    const finalAliasK2 = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: new Date(cleanupReference.getTime() - 15_000),
      consentedAt: new Date(cleanupReference.getTime() - 15_000),
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contentFingerprint: "cleanup-final-alias-content".padEnd(64, "0"),
      contributorKey: "cleanup-final-alias-contributor".padEnd(64, "0"),
      emailFollowUpConsent: false,
      idempotencyActorKey: "cleanup-final-alias-actor".padEnd(64, "0"),
      idempotencyKeyHash: "cleanup-final-alias-k2".padEnd(64, "0"),
      payload: { ...baseSubmission.payload, notes: "Final-expiry K2" },
      requestFingerprint: "cleanup-final-alias-request-k2".padEnd(64, "0"),
      retentionExpiresAt: new Date(cleanupReference.getTime() - 5_000),
      retentionPolicyVersion: "wp08-database-fixture-v2",
    }, database);
    if (!finalAliasK2.duplicate
      || finalAliasK2.id !== finalAliasK1.id
      || finalAliasK2.receiptId !== finalAliasK1.receiptId) {
      throw new Error("Final-expiry fixture did not create two intakes on one semantic parent/receipt.");
    }
    const finalCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 2);
    const [finalCleanupEvidence] = await sql<{ intakes: number; submissions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM submission_idempotency_bindings WHERE submission_id = ${finalAliasK1.id}) AS intakes,
        (SELECT count(*)::int FROM submissions WHERE id = ${finalAliasK1.id}) AS submissions
    `;
    if (
      finalCleanup.deletedIntakes !== 2
      || finalCleanup.deletedSubmissions !== 1
      || finalCleanupEvidence?.intakes !== 0
      || finalCleanupEvidence.submissions !== 0
    ) {
      throw new Error("Final alias expiry did not remove its now-unreferenced semantic parent/receipt.");
    }
    let expiredConsentRejected = false;
    try {
      await submissionRepository.triggerSubmissionEmailFollowUp(
        contactExpiredAlias.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000506", kind: "moderator_question" },
        database,
      );
    } catch (error) {
      expiredConsentRejected = error instanceof Error && error.message === "SUBMISSION_FOLLOW_UP_NOT_AVAILABLE";
    }
    if (!expiredConsentRejected) throw new Error("Expired/redacted contact consent scheduled new email work.");

    await database.delete(schema.submissionEmailFollowUps);
    await database.delete(schema.submissionRateLimitBuckets);

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
          'idempotency_actor_key', 'idempotency_key_hash', 'request_fingerprint', 'content_fingerprint',
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
      "idempotency_actor_key",
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
          canReadBindings: boolean;
          canReadContacts: boolean;
          canReadFollowUps: boolean;
          canReadHmacPin: boolean;
          canReadRateLimits: boolean;
          canExecuteCleanup: boolean;
          canWriteBindings: boolean;
          canWriteContacts: boolean;
          canWriteFollowUps: boolean;
          canWriteHmacPin: boolean;
          canWriteRateLimits: boolean;
          canWriteSubmissions: boolean;
        }[]>`
          SELECT
            has_table_privilege(current_user, 'public.submission_idempotency_bindings', 'SELECT') AS "canReadBindings",
            has_table_privilege(current_user, 'public.submission_intake_contacts', 'SELECT') AS "canReadContacts",
            has_table_privilege(current_user, 'public.submission_email_follow_ups', 'SELECT') AS "canReadFollowUps",
            has_table_privilege(current_user, 'public.submission_hmac_key_pin', 'SELECT') AS "canReadHmacPin",
            has_table_privilege(current_user, 'public.submission_rate_limit_buckets', 'SELECT') AS "canReadRateLimits",
            has_function_privilege(current_user, 'public.cleanup_expired_submission_intakes(integer)', 'EXECUTE') AS "canExecuteCleanup",
            has_table_privilege(current_user, 'public.submission_idempotency_bindings', 'INSERT,UPDATE,DELETE') AS "canWriteBindings",
            has_table_privilege(current_user, 'public.submission_intake_contacts', 'INSERT,UPDATE,DELETE') AS "canWriteContacts",
            has_table_privilege(current_user, 'public.submission_email_follow_ups', 'INSERT,UPDATE,DELETE') AS "canWriteFollowUps",
            has_table_privilege(current_user, 'public.submission_hmac_key_pin', 'INSERT,UPDATE,DELETE') AS "canWriteHmacPin",
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

    const submissionRoleMemberships = await sql<SubmissionRoleMembership[]>`
      SELECT
        granted_role.rolname AS "grantedRole",
        member_role.rolname AS "memberRole",
        grantor_role.rolname AS "grantorRole",
        membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption",
        membership.set_option AS "setOption"
      FROM pg_auth_members AS membership
      INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
      LEFT JOIN pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
      WHERE granted_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
         OR member_role.rolname IN ('repairprint_submission_service', 'repairprint_submission_maintenance')
      ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname
    `;
    const submissionRoleMembershipAssessment = assessSubmissionRoleMemberships(submissionRoleMemberships);
    if (!submissionRoleMembershipAssessment.valid) {
      throw new Error(
        `Submission role membership allowlist is invalid: ${JSON.stringify(submissionRoleMembershipAssessment)}.`,
      );
    }

    await sql.unsafe('SET ROLE "repairprint_submission_service"');
    try {
      const [submissionServiceBoundary] = await sql<{
        currentUser: string;
        forbiddenReadableRelations: number;
        forbiddenOwnerships: number;
        hasCleanupExecute: boolean;
        hasSchemaUsage: boolean;
        leastPrivileged: boolean;
      }[]>`
        SELECT
          current_user AS "currentUser",
          has_schema_privilege(current_user, 'public', 'USAGE') AS "hasSchemaUsage",
          (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
            FROM pg_roles WHERE rolname = current_user) AS "leastPrivileged",
          has_function_privilege(
            current_user,
            'public.cleanup_expired_submission_intakes(integer)',
            'EXECUTE'
          )
          AND has_function_privilege(current_user, 'public.claim_expired_private_media(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_cleanup(uuid,uuid[])', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.claim_private_media_quarantine_cleanup(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_quarantine_cleanup(uuid,uuid[])', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.claim_private_media_pending_object_cleanup(integer,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'public.complete_private_media_pending_object_cleanup(uuid,uuid[])', 'EXECUTE')
          AS "hasCleanupExecute",
          (
            (SELECT count(*)::int FROM pg_database AS database
              WHERE database.datname = current_database()
                AND database.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user))
            + (SELECT count(*)::int FROM pg_namespace AS namespace
              WHERE namespace.nspname = 'public'
                AND namespace.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
            + (SELECT count(*)::int FROM pg_class AS relation
              INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'public'
                AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
            + (SELECT count(*)::int FROM pg_proc AS procedure
              INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
              WHERE namespace.nspname = 'public'
                AND procedure.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
          ) AS "forbiddenOwnerships",
          (SELECT count(*)::int
            FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p', 'v', 'm')
              AND relation.relname NOT IN (
                'submissions',
                'submission_idempotency_bindings',
                'submission_intake_contacts',
                'submission_email_follow_ups',
                'submission_rate_limit_buckets',
                'submission_hmac_key_pin',
                'private_media_upload_sessions',
                'private_media_consents',
                'private_media_assets',
                'private_media_derivatives'
                ,'private_media_pending_objects'
              )
              AND has_table_privilege(current_user, relation.oid, 'SELECT')) AS "forbiddenReadableRelations"
      `;
      const serviceTablePrivileges = await sql<{ privilegeType: string; tableName: string }[]>`
        SELECT table_name AS "tableName", privilege_type AS "privilegeType"
        FROM information_schema.table_privileges
        WHERE grantee = current_user AND table_schema = 'public'
        ORDER BY table_name, privilege_type
      `;
      const expectedServiceTablePrivileges = new Set([
        "submission_email_follow_ups:SELECT",
        "submission_hmac_key_pin:SELECT",
        "submission_idempotency_bindings:SELECT",
        "submission_intake_contacts:SELECT",
        "submission_rate_limit_buckets:DELETE",
        "submission_rate_limit_buckets:SELECT",
        "submissions:SELECT",
        "private_media_upload_sessions:SELECT",
        "private_media_consents:SELECT",
        "private_media_assets:SELECT",
        "private_media_derivatives:SELECT",
        "private_media_pending_objects:SELECT",
        "private_media_pending_objects:DELETE",
      ]);
      const actualServiceTablePrivileges = new Set(serviceTablePrivileges.map(
        (privilege) => `${privilege.tableName}:${privilege.privilegeType}`,
      ));
      const expectedServiceColumnPrivileges = new Set([
        ...["kind", "payload", "intake_version", "hmac_version", "contributor_key", "content_fingerprint"]
          .map((column) => `submissions:${column}:INSERT`),
        ...[
          "kind", "idempotency_actor_key", "idempotency_key_hash", "submission_id", "receipt_id",
          "intake_version", "hmac_version", "request_fingerprint", "payload", "privacy_consent",
          "contribution_consent", "email_follow_up_consent", "contributor_terms_version",
          "privacy_notice_version", "contact_consent_version", "retention_policy_version", "accepted_at",
          "challenge_provider", "challenge_verified_at", "contact_present", "contact_digest",
          "retention_expires_at", "contact_retention_expires_at",
        ].map((column) => `submission_idempotency_bindings:${column}:INSERT`),
        ...["intake_id", "contact_present", "contact_digest", "contact_email"]
          .map((column) => `submission_intake_contacts:${column}:INSERT`),
        ...["intake_id", "submission_id", "follow_up_key", "qualifying_event", "template_key", "available_at"]
          .map((column) => `submission_email_follow_ups:${column}:INSERT`),
        ...["scope", "subject_hash", "window_started_at", "window_seconds", "expires_at"]
          .map((column) => `submission_rate_limit_buckets:${column}:INSERT`),
        ...["request_count", "updated_at"]
          .map((column) => `submission_rate_limit_buckets:${column}:UPDATE`),
        ...["public_id", "intake_id", "kind", "purpose", "quarantine_object_path", "claimed_mime_type",
          "claimed_extension", "claimed_bytes", "capability_nonce_hash", "capability_expires_at"]
          .map((column) => `private_media_upload_sessions:${column}:INSERT`),
        ...["status", "capability_nonce_hash", "capability_expires_at", "finalize_capability_expires_at", "uploaded_at", "processing_lease_token",
          "processing_lease_expires_at", "finalized_at", "terminal_error_code", "updated_at"]
          .map((column) => `private_media_upload_sessions:${column}:UPDATE`),
        ...["session_id", "intake_id", "owns_or_has_permission", "private_storage_consent",
          "derivative_processing_consent", "public_display_consent", "terms_version", "privacy_version",
          "retention_version", "accepted_at", "retention_deadline"]
          .map((column) => `private_media_consents:${column}:INSERT`),
        ...["session_id", "intake_id", "checksum_sha256", "detected_mime_type", "source_bytes",
          "source_width", "source_height", "retention_deadline"]
          .map((column) => `private_media_assets:${column}:INSERT`),
        ...["asset_id", "kind", "object_path", "checksum_sha256", "mime_type", "bytes", "width", "height"]
          .map((column) => `private_media_derivatives:${column}:INSERT`),
        ...["session_id", "kind", "object_path", "delete_after"]
          .map((column) => `private_media_pending_objects:${column}:INSERT`),
      ]);
      const serviceColumnPrivileges = await sql<{ columnName: string; privilegeType: string; tableName: string }[]>`
        SELECT table_name AS "tableName", column_name AS "columnName", privilege_type AS "privilegeType"
        FROM information_schema.column_privileges
        WHERE grantee = current_user
          AND table_schema = 'public'
          AND privilege_type IN ('INSERT', 'UPDATE')
        ORDER BY table_name, column_name, privilege_type
      `;
      const actualServiceColumnPrivileges = new Set(serviceColumnPrivileges.map(
        (privilege) => `${privilege.tableName}:${privilege.columnName}:${privilege.privilegeType}`,
      ));
      if (
        submissionServiceBoundary?.currentUser !== "repairprint_submission_service"
        || !submissionServiceBoundary.hasSchemaUsage
        || !submissionServiceBoundary.leastPrivileged
        || !submissionServiceBoundary.hasCleanupExecute
        || submissionServiceBoundary.forbiddenOwnerships !== 0
        || submissionServiceBoundary.forbiddenReadableRelations !== 0
        || !setsEqual(actualServiceTablePrivileges, expectedServiceTablePrivileges)
        || !setsEqual(actualServiceColumnPrivileges, expectedServiceColumnPrivileges)
      ) {
        throw new Error(`Submission service privilege allowlist is invalid: ${JSON.stringify({
          actualColumns: [...actualServiceColumnPrivileges],
          actualTables: [...actualServiceTablePrivileges],
          boundary: submissionServiceBoundary,
        })}.`);
      }
      await sql`SELECT count(*) FROM submissions`;
      await sql`SELECT count(*) FROM submission_idempotency_bindings`;
      await sql`SELECT count(*) FROM submission_intake_contacts`;
      await sql`SELECT count(*) FROM submission_rate_limit_buckets`;
      await sql`SELECT count(*) FROM submission_email_follow_ups`;
      await sql`SELECT count(*) FROM submission_hmac_key_pin`;
      await sql`SELECT count(*) FROM private_media_upload_sessions`;
      await sql`SELECT count(*) FROM private_media_consents`;
      await sql`SELECT count(*) FROM private_media_assets`;
      await sql`SELECT count(*) FROM private_media_derivatives`;
      await sql`SELECT count(*) FROM private_media_pending_objects`;
      let mediaRedactionsDenied = false;
      try { await sql`SELECT count(*) FROM private_media_redactions`; }
      catch (error) { mediaRedactionsDenied = hasDatabaseErrorCode(error, "42501"); }
      if (!mediaRedactionsDenied) throw new Error("Submission service could read staff-only media redactions.");
      let serviceLegacyParentDenied = false;
      let serviceUnpinnedVersionDenied = false;
      try {
        await sql`INSERT INTO submissions (kind, payload)
          VALUES ('missing_part', '{"brand":"forbidden service v0"}'::jsonb)`;
      } catch (error) {
        serviceLegacyParentDenied = hasDatabaseErrorCode(error, "23514");
      }
      try {
        await sql`INSERT INTO submissions (
          kind, payload, intake_version, hmac_version, contributor_key, content_fingerprint
        ) VALUES (
          'missing_part',
          '{"brand":"forbidden service version"}'::jsonb,
          1,
          'hmac-sha256/unsupported',
          ${fixtureDigest("service-role-forbidden-version-contributor")},
          ${fixtureDigest("service-role-forbidden-version-content")}
        )`;
      } catch (error) {
        serviceUnpinnedVersionDenied = hasDatabaseErrorCode(error, "23514");
      }
      if (!serviceLegacyParentDenied || !serviceUnpinnedVersionDenied) {
        throw new Error("Submission service inserted a legacy or unpinned semantic parent.");
      }
      const serviceNow = new Date();
      const serviceConsentAt = new Date(serviceNow.getTime() - 60_000);
      const serviceLiveSubmission = await submissionRepository.persistAnonymousSubmission({
        challengeVerifiedAt: serviceConsentAt,
        consentedAt: serviceConsentAt,
        contactEmail: "service-role-live@example.invalid",
        contactRetentionExpiresAt: new Date(serviceNow.getTime() + 5 * 60_000),
        contentFingerprint: "service-role-live-content".padEnd(64, "0"),
        contributorKey: "service-role-live-contributor".padEnd(64, "0"),
        emailFollowUpConsent: true,
        idempotencyActorKey: "service-role-live-actor".padEnd(64, "0"),
        idempotencyKeyHash: "service-role-live-idempotency".padEnd(64, "0"),
        kind: "missing_part",
        payload: { brand: "Service role live fixture", brokenPart: "Latch", modelNumber: "SR-LIVE-100" },
        requestFingerprint: "service-role-live-request".padEnd(64, "0"),
        retentionExpiresAt: new Date(serviceNow.getTime() + 10 * 60_000),
        retentionPolicyVersion: "wp08-service-role-fixture-v1",
      }, database);
      const serviceSubmission = await submissionRepository.persistAnonymousSubmission({
        challengeVerifiedAt: serviceConsentAt,
        consentedAt: serviceConsentAt,
        contactEmail: "service-role-private@example.invalid",
        contactRetentionExpiresAt: new Date(serviceNow.getTime() - 30_000),
        contentFingerprint: "service-role-content".padEnd(64, "0"),
        contributorKey: "service-role-contributor".padEnd(64, "0"),
        idempotencyActorKey: "service-role-actor".padEnd(64, "0"),
        idempotencyKeyHash: "service-role-idempotency".padEnd(64, "0"),
        kind: "missing_part",
        payload: { brand: "Service role fixture", brokenPart: "Latch", modelNumber: "SR-100" },
        requestFingerprint: "service-role-request".padEnd(64, "0"),
        retentionExpiresAt: new Date(serviceNow.getTime() - 10_000),
        retentionPolicyVersion: "wp08-service-role-fixture-v1",
      }, database);
      await submissionRepository.triggerSubmissionEmailFollowUp(
        serviceLiveSubmission.intakeId,
        { eventId: "00000000-0000-4000-8000-000000000508", kind: "moderator_question" },
        database,
      );
      let expiredDirectFollowUpDenied = false;
      try {
        await sql`INSERT INTO submission_email_follow_ups (
          intake_id, submission_id, follow_up_key, qualifying_event, template_key, available_at
        ) VALUES (
          ${serviceSubmission.intakeId},
          ${serviceSubmission.id},
          ${`intake:${serviceSubmission.intakeId}:moderator_question:00000000-0000-4000-8000-000000000509`},
          'moderator_question',
          'moderator-follow-up',
          CURRENT_TIMESTAMP
        )`;
      } catch (error) {
        expiredDirectFollowUpDenied = hasDatabaseErrorCode(error, "23514");
      }
      if (!expiredDirectFollowUpDenied) {
        throw new Error("Submission service directly queued follow-up work for an expired intake.");
      }
      const serviceRate = await submissionRepository.consumeSubmissionRateLimitBuckets([{
        expiresAt: new Date(serviceNow.getTime() + 600_000),
        limit: 2,
        scope: "wp08-service-role-fixture",
        subjectHash: "service-role-rate-subject".padEnd(64, "0"),
        windowSeconds: 600,
        windowStartedAt: serviceConsentAt,
      }], serviceConsentAt, database);
      let expiredDeleteDenied = false;
      let expiredUpdateDenied = false;
      let identityUpdateDenied = false;
      let liveDeleteDenied = false;
      let liveUpdateDenied = false;
      let pinInsertDenied = false;
      let pinUpdateDenied = false;
      let pinDeleteDenied = false;
      try {
        await sql`UPDATE submission_idempotency_bindings
          SET request_fingerprint = ${fixtureDigest("service-role-forbidden-update")}
          WHERE id = ${serviceLiveSubmission.intakeId}`;
      } catch (error) {
        liveUpdateDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`UPDATE submission_idempotency_bindings
          SET request_fingerprint = ${fixtureDigest("service-role-forbidden-expired-update")}
          WHERE id = ${serviceSubmission.intakeId}`;
      } catch (error) {
        expiredUpdateDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`UPDATE submission_idempotency_bindings
          SET idempotency_actor_key = ${fixtureDigest("service-role-forbidden-actor")},
              idempotency_key_hash = ${fixtureDigest("service-role-forbidden-uuid")}
          WHERE id = ${serviceLiveSubmission.intakeId}`;
      } catch (error) {
        identityUpdateDenied = hasDatabaseErrorCode(error, "42501");
      }
      let referenceUpdateDenied = false;
      try {
        await sql`UPDATE submission_idempotency_bindings
          SET submission_id = ${serviceSubmission.id}, receipt_id = ${serviceSubmission.receiptId}
          WHERE id = ${serviceLiveSubmission.intakeId}`;
      } catch (error) {
        referenceUpdateDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`DELETE FROM submission_idempotency_bindings WHERE id = ${serviceLiveSubmission.intakeId}`;
      } catch (error) {
        liveDeleteDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`DELETE FROM submission_idempotency_bindings WHERE id = ${serviceSubmission.intakeId}`;
      } catch (error) {
        expiredDeleteDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`INSERT INTO submission_hmac_key_pin (singleton, hmac_version, key_commitment)
          VALUES (false, 'forbidden/v1', ${fixtureDigest("service-role-forbidden-pin")})`;
      } catch (error) {
        pinInsertDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`UPDATE submission_hmac_key_pin SET key_commitment = key_commitment`;
      } catch (error) {
        pinUpdateDenied = hasDatabaseErrorCode(error, "42501");
      }
      try {
        await sql`DELETE FROM submission_hmac_key_pin`;
      } catch (error) {
        pinDeleteDenied = hasDatabaseErrorCode(error, "42501");
      }
      if (
        !liveUpdateDenied
        || !expiredUpdateDenied
        || !identityUpdateDenied
        || !referenceUpdateDenied
        || !liveDeleteDenied
        || !expiredDeleteDenied
        || !pinInsertDenied
        || !pinUpdateDenied
        || !pinDeleteDenied
      ) {
        throw new Error("Submission service could mutate immutable intake or HMAC pin state directly.");
      }
      const serviceCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 1);
      if (
        !serviceRate.allowed
        || serviceCleanup.deletedSubmissions !== 1
        || serviceCleanup.deletedIntakes !== 1
        || serviceCleanup.deletedContacts !== 1
        || serviceCleanup.deletedFollowUps !== 0
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
        throw new Error("Submission service role can read outside its six-table private allowlist.");
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

    const [manualPolicy] = await sql<{ id: string }[]>`
      SELECT public.record_source_policy_review(
        'example.invalid', 'manual-review-2026-07', 'https://example.invalid/fictional-terms', ${"1".repeat(64)},
        '2026-07-11T00:00:00Z'::timestamptz, '2027-07-12T00:00:00Z'::timestamptz,
        'creator_submission'::source_policy,
        '["landing_page_url","creator_name","title","claimed_compatibility","license_state"]'::jsonb,
        false, NULL, false, '{"kind":"fictional-test-review"}'::jsonb, ${staff.id},
        'Record the fictional manual-source policy fixture.', 'req_source_policy_manual'
      ) AS id
    `;
    const [fixtureAdapterPolicy] = await sql<{ id: string }[]>`
      SELECT public.record_source_policy_review(
        'fixture.thingiverse.invalid', 'fixture-api-review-2026-07', 'https://example.invalid/fixture-api-terms', ${"2".repeat(64)},
        '2026-07-11T00:00:00Z'::timestamptz, '2027-07-12T00:00:00Z'::timestamptz,
        'written_permission'::source_policy,
        '["external_id","landing_page_url","title","creator","license","source_revision"]'::jsonb,
        true, true, true, '{"kind":"fictional-fixture-only-permission"}'::jsonb, ${staff.id},
        'Record a fictional adapter policy used only by database tests.', 'req_source_policy_fixture'
      ) AS id
    `;
    if (!manualPolicy || !fixtureAdapterPolicy) throw new Error("Source policy review fixtures were not recorded.");

    const manualPayload = { landing_page_url: "https://example.invalid/manual/42", creator_name: "Fixture creator", title: "Fixture candidate" };
    const manualChecksum = fixtureDigest(JSON.stringify(manualPayload));
    const manualAcquisitionFingerprint = fixtureDigest("manual-source-acquisition-one");
    const manualFirst = await sql<{ candidateId: string; versionId: string; versionCreated: boolean }[]>`
      SELECT candidate_id AS "candidateId", version_id AS "versionId", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'example.invalid', 'manual-42', 'manual', ${manualChecksum}, ${JSON.stringify(manualPayload)}::jsonb, 'manual-v1',
        ${manualPolicy.id}, clock_timestamp(), ${staff.id}, 'req_source_manual_first', NULL, NULL,
        ${manualAcquisitionFingerprint}
      )
    `;
    const manualRetry = await sql<{ candidateId: string; versionId: string; versionCreated: boolean }[]>`
      SELECT candidate_id AS "candidateId", version_id AS "versionId", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'example.invalid', 'manual-42', 'manual', ${manualChecksum}, ${JSON.stringify(manualPayload)}::jsonb, 'manual-v1',
        ${manualPolicy.id}, clock_timestamp(), ${staff.id}, 'req_source_manual_retry', NULL, NULL,
        ${manualAcquisitionFingerprint}
      )
    `;
    const changedManualPayload = { ...manualPayload, title: "Fixture candidate revision two" };
    const manualChanged = await sql<{ candidateId: string; versionId: string; versionCreated: boolean }[]>`
      SELECT candidate_id AS "candidateId", version_id AS "versionId", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'example.invalid', 'manual-42', 'manual', ${fixtureDigest(JSON.stringify(changedManualPayload))},
        ${JSON.stringify(changedManualPayload)}::jsonb, 'manual-v1', ${manualPolicy.id}, clock_timestamp(), ${staff.id},
        'req_source_manual_changed', NULL, NULL, ${fixtureDigest("manual-source-acquisition-two")}
      )
    `;
    if (!manualFirst[0]?.versionCreated || manualRetry[0]?.versionCreated || !manualChanged[0]?.versionCreated
      || manualFirst[0]?.candidateId !== manualRetry[0]?.candidateId
      || manualFirst[0]?.candidateId !== manualChanged[0]?.candidateId
      || manualFirst[0]?.versionId !== manualRetry[0]?.versionId
      || manualFirst[0]?.versionId === manualChanged[0]?.versionId) {
      throw new Error("Manual source candidate retry/version identity is not idempotent.");
    }

    const adapterPayload = { external_id: "fixture-7", landing_page_url: "https://example.invalid/fixture/7", title: "Adapter fixture" };
    const adapterChecksum = fixtureDigest(JSON.stringify(adapterPayload));
    const adapterRunFingerprint = fixtureDigest("fixture-adapter-run-one");
    const adapterAcquisitionFingerprint = fixtureDigest("fixture-adapter-acquisition-one");
    const adapterFirst = await sql<{ runId: string; candidateId: string; versionId: string; runCreated: boolean; versionCreated: boolean }[]>`
      SELECT run_id AS "runId", candidate_id AS "candidateId", version_id AS "versionId",
        run_created AS "runCreated", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'adapter', ${adapterChecksum}, ${JSON.stringify(adapterPayload)}::jsonb,
        'fixture-v1', ${fixtureAdapterPolicy.id}, clock_timestamp(), ${staff.id}, 'req_source_adapter_first',
        'src_fixture_run_one', ${adapterRunFingerprint}, ${adapterAcquisitionFingerprint}
      )
    `;
    const adapterRetry = await sql<typeof adapterFirst>`
      SELECT run_id AS "runId", candidate_id AS "candidateId", version_id AS "versionId",
        run_created AS "runCreated", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'adapter', ${adapterChecksum}, ${JSON.stringify(adapterPayload)}::jsonb,
        'fixture-v1', ${fixtureAdapterPolicy.id}, clock_timestamp(), ${staff.id}, 'req_source_adapter_retry',
        'src_fixture_run_one', ${adapterRunFingerprint}, ${adapterAcquisitionFingerprint}
      )
    `;
    const adapterChangedPayload = { ...adapterPayload, title: "Adapter fixture revision two" };
    const adapterChanged = await sql<typeof adapterFirst>`
      SELECT run_id AS "runId", candidate_id AS "candidateId", version_id AS "versionId",
        run_created AS "runCreated", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'adapter', ${fixtureDigest(JSON.stringify(adapterChangedPayload))},
        ${JSON.stringify(adapterChangedPayload)}::jsonb, 'fixture-v1', ${fixtureAdapterPolicy.id}, clock_timestamp(), ${staff.id},
        'req_source_adapter_changed', 'src_fixture_run_two', ${fixtureDigest("fixture-adapter-run-two")},
        ${fixtureDigest("fixture-adapter-acquisition-two")}
      )
    `;
    if (!adapterFirst[0]?.runCreated || !adapterFirst[0]?.versionCreated
      || adapterRetry[0]?.runCreated || adapterRetry[0]?.versionCreated
      || !adapterChanged[0]?.runCreated || !adapterChanged[0]?.versionCreated
      || adapterFirst[0]?.runId !== adapterRetry[0]?.runId
      || adapterFirst[0]?.candidateId !== adapterChanged[0]?.candidateId
      || adapterFirst[0]?.versionId === adapterChanged[0]?.versionId) {
      throw new Error("Adapter run/candidate retry identity is not idempotent.");
    }

    const [fixtureAdapterPolicyTwo] = await sql<{ id: string }[]>`
      SELECT public.record_source_policy_review(
        'fixture.thingiverse.invalid', 'fixture-api-review-2026-07-b',
        'https://example.invalid/fixture-api-terms-v2', ${"5".repeat(64)},
        '2026-07-12T00:00:00Z'::timestamptz, '2027-07-13T00:00:00Z'::timestamptz,
        'written_permission'::source_policy,
        '["external_id","landing_page_url","title","creator","license","source_revision"]'::jsonb,
        true, true, true, '{"kind":"fictional-fixture-only-permission-v2"}'::jsonb, ${staff.id},
        'Replace the fictional adapter policy for an identity-race fixture.', 'req_source_policy_fixture_v2'
      ) AS id
    `;
    if (!fixtureAdapterPolicyTwo) throw new Error("Replacement source policy fixture was not recorded.");
    let forbiddenPolicyFieldRejected = false;
    try {
      await sql`SELECT public.record_source_policy_review(
        'forbidden-policy.invalid', 'forbidden-fields-v1', 'https://example.invalid/forbidden-terms', ${"7".repeat(64)},
        '2026-07-12T00:00:00Z'::timestamptz, '2027-07-13T00:00:00Z'::timestamptz,
        'creator_submission'::source_policy, '["title","files"]'::jsonb,
        false, NULL, false, '{"kind":"must-not-persist"}'::jsonb, ${staff.id},
        'Reject forbidden policy metadata fields.', 'req_source_policy_forbidden_fields'
      )`;
    } catch (error) {
      forbiddenPolicyFieldRejected = error instanceof Error && error.message.includes("SOURCE_POLICY_REVIEW_INVALID");
    }
    const [forbiddenPolicyRows] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM source_platform_policies WHERE platform = 'forbidden-policy.invalid'
    `;
    if (!forbiddenPolicyFieldRejected || forbiddenPolicyRows?.count !== 0) {
      throw new Error("The database policy field ceiling accepted forbidden source metadata.");
    }

    for (const [label, assignment, expectedError] of [
      ["permission scope", "permission_scope = 'review:wrong'", "SOURCE_POLICY_REVIEW_MISMATCH"],
      ["terms URL", "terms_url = 'https://example.invalid/wrong-terms'", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["terms checksum", `terms_checksum = '${"8".repeat(64)}'`, "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["terms checked time", "terms_checked_at = terms_checked_at - interval '1 second'", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["decision", "policy = 'api'", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["allowed fields", "allowed_fields = '[\"external_id\"]'::jsonb", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["automation", "automation_allowed = false", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["commercial use", "commercial_use_allowed = false", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["adapter state", "adapter_enabled = false", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["image reuse", "image_reuse_allowed = true", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
      ["file reuse", "file_rehosting_allowed = true", "SOURCE_POLICY_SNAPSHOT_MISMATCH"],
    ] as const) {
      let exactSnapshotRejected = false;
      try {
        await sql.begin(async (transaction) => {
          await transaction.unsafe(`UPDATE source_platform_policies SET ${assignment} WHERE platform = 'fixture.thingiverse.invalid'`);
          await transaction`SELECT public.upsert_private_source_candidate(
            'fixture.thingiverse.invalid', ${`snapshot-${label}`}, 'adapter', ${"9".repeat(64)},
            '{"external_id":"snapshot"}'::jsonb, 'fixture-v1', ${fixtureAdapterPolicyTwo.id},
            clock_timestamp(), ${staff.id}, ${`req_source_snapshot_${label.replaceAll(" ", "_")}`},
            ${`src_snapshot_${label.replaceAll(" ", "_")}`}, ${fixtureDigest(`snapshot-run-${label}`)},
            ${fixtureDigest(`snapshot-acquisition-${label}`)}
          )`;
          throw new Error("SOURCE_SNAPSHOT_UNEXPECTED_SUCCESS");
        });
      } catch (error) {
        exactSnapshotRejected = error instanceof Error && error.message.includes(expectedError);
      }
      if (!exactSnapshotRejected) throw new Error(`Current policy ${label} mismatch did not fail closed.`);
    }
    const [beforeStaleReviewAttempt] = await sql<{ acquisitions: number; candidates: number; runs: number; versions: number }[]>`
      SELECT (SELECT count(*)::int FROM source_candidate_acquisitions) AS acquisitions,
        (SELECT count(*)::int FROM source_candidates) AS candidates,
        (SELECT count(*)::int FROM source_adapter_runs) AS runs,
        (SELECT count(*)::int FROM source_candidate_versions) AS versions
    `;
    let staleEvaluatedReviewRejected = false;
    try {
      await sql`SELECT public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'policy-changed-before-persist', 'adapter', ${"6".repeat(64)},
        '{"external_id":"policy-changed-before-persist"}'::jsonb, 'fixture-v1', ${fixtureAdapterPolicy.id},
        clock_timestamp(), ${staff.id}, 'req_source_stale_evaluated_review', 'src_stale_policy',
        ${fixtureDigest("stale-policy-run")}, ${fixtureDigest("stale-policy-acquisition")}
      )`;
    } catch (error) {
      staleEvaluatedReviewRejected = error instanceof Error && error.message.includes("SOURCE_POLICY_REVIEW_MISMATCH");
    }
    const [afterStaleReviewAttempt] = await sql<{ acquisitions: number; candidates: number; runs: number; versions: number }[]>`
      SELECT (SELECT count(*)::int FROM source_candidate_acquisitions) AS acquisitions,
        (SELECT count(*)::int FROM source_candidates) AS candidates,
        (SELECT count(*)::int FROM source_adapter_runs) AS runs,
        (SELECT count(*)::int FROM source_candidate_versions) AS versions
    `;
    if (!staleEvaluatedReviewRejected
      || JSON.stringify(beforeStaleReviewAttempt) !== JSON.stringify(afterStaleReviewAttempt)) {
      throw new Error("A policy change between evaluation and persistence did not fail closed without writes.");
    }

    const adapterPolicyTwo = await sql<typeof adapterFirst>`
      SELECT run_id AS "runId", candidate_id AS "candidateId", version_id AS "versionId",
        run_created AS "runCreated", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'adapter', ${adapterChecksum}, ${JSON.stringify(adapterPayload)}::jsonb,
        'fixture-v1', ${fixtureAdapterPolicyTwo.id}, clock_timestamp(), ${staff.id}, 'req_source_adapter_policy_two',
        'src_fixture_run_policy_two', ${fixtureDigest("fixture-adapter-run-policy-two")},
        ${fixtureDigest("fixture-adapter-acquisition-policy-two")}
      )
    `;
    const adapterManualOrigin = await sql<typeof adapterFirst>`
      SELECT run_id AS "runId", candidate_id AS "candidateId", version_id AS "versionId",
        run_created AS "runCreated", version_created AS "versionCreated"
      FROM public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'manual', ${adapterChecksum}, ${JSON.stringify(adapterPayload)}::jsonb,
        'manual-v1', ${fixtureAdapterPolicyTwo.id}, clock_timestamp(), ${staff.id}, 'req_source_manual_other_origin',
        NULL, NULL, ${fixtureDigest("fixture-manual-other-origin")}
      )
    `;
    if (!adapterPolicyTwo[0]?.runCreated || adapterPolicyTwo[0].versionCreated
      || adapterPolicyTwo[0].versionId !== adapterFirst[0]?.versionId
      || adapterManualOrigin[0]?.runId !== null || adapterManualOrigin[0]?.versionCreated
      || adapterManualOrigin[0]?.versionId !== adapterFirst[0]?.versionId) {
      throw new Error("Identical content did not retain independent policy/run/origin acquisition provenance.");
    }
    const adapterAcquisitions = await sql<{ adapterRunId: string | null; origin: string; policyReviewId: string }[]>`
      SELECT acquisition.adapter_run_id AS "adapterRunId", acquisition.origin::text AS origin,
        acquisition.policy_review_id AS "policyReviewId"
      FROM source_candidate_acquisitions AS acquisition
      WHERE acquisition.version_id = ${adapterFirst[0]?.versionId}
      ORDER BY acquisition.created_at, acquisition.id
    `;
    if (adapterAcquisitions.length !== 3
      || !adapterAcquisitions.some((row) => row.policyReviewId === fixtureAdapterPolicy.id && row.origin === "adapter")
      || !adapterAcquisitions.some((row) => row.policyReviewId === fixtureAdapterPolicyTwo.id && row.origin === "adapter" && row.adapterRunId === adapterPolicyTwo[0]?.runId)
      || !adapterAcquisitions.some((row) => row.policyReviewId === fixtureAdapterPolicyTwo.id && row.origin === "manual" && row.adapterRunId === null)) {
      throw new Error(`Acquisition provenance was incomplete: ${JSON.stringify(adapterAcquisitions)}.`);
    }

    let checksumPayloadConflictRejected = false;
    try {
      await sql`SELECT public.upsert_private_source_candidate(
        'fixture.thingiverse.invalid', 'fixture-7', 'adapter', ${adapterChecksum},
        '{"external_id":"fixture-7","title":"conflicting payload with reused checksum"}'::jsonb,
        'fixture-v1', ${fixtureAdapterPolicyTwo.id}, clock_timestamp(), ${staff.id},
        'req_source_checksum_payload_conflict', 'src_fixture_checksum_conflict',
        ${fixtureDigest("fixture-checksum-conflict-run")}, ${fixtureDigest("fixture-checksum-conflict-acquisition")}
      )`;
    } catch (error) {
      checksumPayloadConflictRejected = error instanceof Error && error.message.includes("SOURCE_CANDIDATE_PAYLOAD_CONFLICT");
    }
    if (!checksumPayloadConflictRejected) throw new Error("A checksum/payload identity conflict was not rejected.");

    const concurrentPayload = { external_id: "fixture-concurrent", title: "Concurrent acquisition fixture" };
    const concurrentChecksum = fixtureDigest(JSON.stringify(concurrentPayload));
    const concurrentSql = postgres(databaseUrl, { prepare: false, max: 1 });
    let concurrentResults: Array<{ runId: string; versionId: string }>;
    try {
      concurrentResults = (await Promise.all([
        sql<{ runId: string; versionId: string }[]>`
          SELECT run_id AS "runId", version_id AS "versionId" FROM public.upsert_private_source_candidate(
            'fixture.thingiverse.invalid', 'fixture-concurrent', 'adapter', ${concurrentChecksum},
            ${JSON.stringify(concurrentPayload)}::text::jsonb, 'fixture-v1', ${fixtureAdapterPolicyTwo.id},
            clock_timestamp(), ${staff.id}, 'req_source_concurrent_a', 'src_source_concurrent_a',
            ${fixtureDigest("source-concurrent-run-a")}, ${fixtureDigest("source-concurrent-acquisition-a")}
          )`,
        concurrentSql<{ runId: string; versionId: string }[]>`
          SELECT run_id AS "runId", version_id AS "versionId" FROM public.upsert_private_source_candidate(
            'fixture.thingiverse.invalid', 'fixture-concurrent', 'adapter', ${concurrentChecksum},
            ${JSON.stringify(concurrentPayload)}::text::jsonb, 'fixture-v1', ${fixtureAdapterPolicyTwo.id},
            clock_timestamp(), ${staff.id}, 'req_source_concurrent_b', 'src_source_concurrent_b',
            ${fixtureDigest("source-concurrent-run-b")}, ${fixtureDigest("source-concurrent-acquisition-b")}
          )`,
      ])).flat();
    } finally {
      await concurrentSql.end();
    }
    const [concurrentProvenance] = await sql<{ acquisitions: number; runs: number; versions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM source_candidate_versions AS version
          INNER JOIN source_candidates AS candidate ON candidate.id = version.candidate_id
          WHERE candidate.platform = 'fixture.thingiverse.invalid' AND candidate.external_id = 'fixture-concurrent') AS versions,
        (SELECT count(*)::int FROM source_candidate_acquisitions AS acquisition
          INNER JOIN source_candidates AS candidate ON candidate.id = acquisition.candidate_id
          WHERE candidate.platform = 'fixture.thingiverse.invalid' AND candidate.external_id = 'fixture-concurrent') AS acquisitions,
        (SELECT count(*)::int FROM source_adapter_runs WHERE public_id IN ('src_source_concurrent_a', 'src_source_concurrent_b')) AS runs
    `;
    if (concurrentResults.length !== 2 || concurrentResults[0]?.versionId !== concurrentResults[1]?.versionId
      || concurrentResults[0]?.runId === concurrentResults[1]?.runId
      || concurrentProvenance?.versions !== 1 || concurrentProvenance.acquisitions !== 2 || concurrentProvenance.runs !== 2) {
      throw new Error(`Concurrent acquisition provenance was not exact: ${JSON.stringify({ concurrentResults, concurrentProvenance })}.`);
    }

    const sourceServiceUrl = await provisionSourceServiceRole(sql, databaseUrl);
    const sourceService = postgres(sourceServiceUrl, { prepare: false, max: 1 });
    try {
      const [sourceServiceBoundary] = await sourceService<{
        currentUser: string;
        intendedFunctions: number;
        unsafeAttributes: boolean;
      }[]>`
        SELECT current_user AS "currentUser",
          (SELECT count(*)::int FROM (VALUES
            ('public.upsert_private_source_candidate(text,text,public.source_candidate_origin,text,jsonb,text,uuid,timestamptz,uuid,text,text,text,text)'),
            ('public.transition_source_candidate_version(uuid,public.source_ingestion_stage,public.source_ingestion_stage,uuid,text,text)'),
            ('public.claim_source_link_check_jobs(text,integer,integer)'),
            ('public.complete_source_link_check(uuid,uuid,uuid,integer,text,text,integer,text,integer,timestamptz,text,text)')
          ) AS intended(signature)
          WHERE has_function_privilege(current_user, intended.signature, 'EXECUTE')) AS "intendedFunctions",
          (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls OR NOT rolcanlogin
            FROM pg_roles WHERE rolname = current_user) AS "unsafeAttributes"
      `;
      if (sourceServiceBoundary?.currentUser !== "repairprint_source_service"
        || sourceServiceBoundary.intendedFunctions !== 4 || sourceServiceBoundary.unsafeAttributes) {
        throw new Error(`Genuine source-service identity is invalid: ${JSON.stringify(sourceServiceBoundary)}.`);
      }

      const servicePayload = { external_id: "service-role-source", title: "Service role private source fixture" };
      const [serviceCandidate] = await sourceService<{ versionId: string }[]>`
        SELECT version_id AS "versionId" FROM public.upsert_private_source_candidate(
          'fixture.thingiverse.invalid', 'service-role-source', 'adapter',
          ${fixtureDigest(JSON.stringify(servicePayload))}, ${JSON.stringify(servicePayload)}::text::jsonb,
          'fixture-v1', ${fixtureAdapterPolicyTwo.id}, clock_timestamp(), ${staff.id},
          'req_source_service_upsert', 'src_source_service_upsert',
          ${fixtureDigest("source-service-run")}, ${fixtureDigest("source-service-acquisition")}
        )
      `;
      if (!serviceCandidate) throw new Error("Genuine source service could not execute candidate upsert.");
      await sourceService`SELECT public.transition_source_candidate_version(
        ${serviceCandidate.versionId}, 'discovered', 'fetched', ${staff.id},
        'Advance the genuine-role private candidate fixture.', 'req_source_service_transition'
      )`;

      const [serviceSource] = await sql<{ id: string }[]>`
        INSERT INTO sources (source_type, platform, canonical_url, title, retrieved_at, last_checked_at, status)
        VALUES ('fixture', 'fixture.thingiverse.invalid', 'https://example.invalid/source-role-link',
          'Genuine source role link fixture', clock_timestamp(), clock_timestamp(), 'live')
        RETURNING id
      `;
      if (!serviceSource) throw new Error("Genuine source-service link fixture was not created.");
      await sql`UPDATE source_link_check_jobs SET next_check_at = clock_timestamp() + interval '1 day'`;
      await sql`UPDATE source_link_check_jobs SET next_check_at = clock_timestamp() - interval '1 second'
        WHERE source_id = ${serviceSource.id}`;
      const [serviceClaim] = await sourceService<{ jobId: string; leaseToken: string }[]>`
        SELECT job_id AS "jobId", lease_token AS "leaseToken"
        FROM public.claim_source_link_check_jobs('genuine-source-service', 1, 120)
      `;
      if (!serviceClaim) throw new Error("Genuine source service could not claim link work.");
      await sourceService`SELECT public.complete_source_link_check(
        ${serviceClaim.jobId}, ${serviceClaim.leaseToken}, ${staff.id}, 200, 'healthy',
        'https://example.invalid/source-role-link', 7, NULL, 0, NULL, ${fixtureDigest("source-service-link-body")},
        'req_source_service_complete'
      )`;

      let directReadDenied = false;
      let directWriteDenied = false;
      let unrelatedFunctionDenied = false;
      try { await sourceService`SELECT count(*) FROM source_candidates`; }
      catch (error) { directReadDenied = hasDatabaseErrorCode(error, "42501"); }
      try {
        await sourceService`INSERT INTO source_candidates (platform, external_id, origin, created_by)
          VALUES ('fixture.thingiverse.invalid', 'forbidden-direct-write', 'manual', ${staff.id})`;
      } catch (error) { directWriteDenied = hasDatabaseErrorCode(error, "42501"); }
      try { await sourceService`SELECT public.refresh_source_public_search()`; }
      catch (error) { unrelatedFunctionDenied = hasDatabaseErrorCode(error, "42501"); }
      if (!directReadDenied || !directWriteDenied || !unrelatedFunctionDenied) {
        throw new Error("Genuine source service exceeded its four-function boundary.");
      }
    } finally {
      await sourceService.end();
    }

    for (const status of [400, 405, 408, 416, 418, 451, 429] as const) {
      const [statusSource] = await sql<{ id: string }[]>`
        INSERT INTO sources (source_type, platform, canonical_url, title, retrieved_at, last_checked_at, status)
        VALUES ('fixture', 'fixture.thingiverse.invalid', ${`https://example.invalid/status/${status}`},
          ${`HTTP ${status} completion fixture`}, clock_timestamp(), clock_timestamp(), 'live')
        RETURNING id
      `;
      if (!statusSource) throw new Error(`HTTP ${status} source fixture was not created.`);
      await sql`UPDATE source_link_check_jobs SET next_check_at = clock_timestamp() + interval '1 day'`;
      await sql`UPDATE source_link_check_jobs SET next_check_at = clock_timestamp() - interval '1 second'
        WHERE source_id = ${statusSource.id}`;
      const [statusClaim] = await sql<{ jobId: string; leaseToken: string }[]>`
        SELECT job_id AS "jobId", lease_token AS "leaseToken"
        FROM public.claim_source_link_check_jobs(${`status-worker-${status}`}, 1, 120)
      `;
      if (!statusClaim) throw new Error(`HTTP ${status} job was not claimed.`);
      const outcome = classifySourceLinkStatus(status);
      const suppliedRetryAfter = status === 429 ? new Date("2100-01-01T00:00:00Z") : null;
      await sql`SELECT public.complete_source_link_check(
        ${statusClaim.jobId}, ${statusClaim.leaseToken}, ${staff.id}, ${status}, ${outcome},
        ${`https://example.invalid/status/${status}`}, 4, NULL, 0, ${suppliedRetryAfter},
        ${fixtureDigest(`status-body-${status}`)}, ${`req_source_status_${status}`}
      )`;
      const [statusCompletion] = await sql<{
        checkStatus: number;
        jobStatus: string;
        nextDelaySeconds: number;
        outcome: string;
        sourceStatus: string;
      }[]>`
        SELECT check.http_status AS "checkStatus", check.outcome,
          job.status::text AS "jobStatus",
          extract(epoch FROM (job.next_check_at - job.updated_at))::int AS "nextDelaySeconds",
          source.status AS "sourceStatus"
        FROM source_link_check_jobs AS job
        INNER JOIN source_link_checks AS check ON check.job_id = job.id
        INNER JOIN sources AS source ON source.id = job.source_id
        WHERE job.id = ${statusClaim.jobId}
        ORDER BY check.checked_at DESC LIMIT 1
      `;
      if (statusCompletion?.checkStatus !== status || statusCompletion.outcome !== outcome
        || statusCompletion.jobStatus !== "pending" || statusCompletion.nextDelaySeconds < 60
        || (status === 429 && statusCompletion.nextDelaySeconds > 86_400)
        || (status === 451 && statusCompletion.sourceStatus !== "restricted")) {
        throw new Error(`HTTP ${status} claim/observation/completion contract failed: ${JSON.stringify(statusCompletion)}.`);
      }
    }

    let manualPolicyBlockedAdapter = false;
    try {
      await sql`SELECT public.upsert_private_source_candidate(
        'example.invalid', 'forbidden-adapter', 'adapter', ${"3".repeat(64)}, '{}'::jsonb, 'fixture-v1',
        ${manualPolicy.id}, clock_timestamp(), ${staff.id}, 'req_forbidden_adapter', 'src_forbidden', ${"4".repeat(64)},
        ${fixtureDigest("forbidden-adapter-acquisition")}
      )`;
    } catch (error) {
      manualPolicyBlockedAdapter = error instanceof Error && error.message.includes("SOURCE_AUTOMATION_FORBIDDEN");
    }
    if (!manualPolicyBlockedAdapter) throw new Error("Manual-only source policy did not block adapter ingestion.");

    let policyEvidenceImmutable = false;
    try {
      await sql`UPDATE source_policy_reviews SET adapter_enabled = true WHERE id = ${manualPolicy.id}`;
    } catch (error) {
      policyEvidenceImmutable = error instanceof Error && error.message.includes("append-only");
    }
    if (!policyEvidenceImmutable) throw new Error("Source policy review evidence is not immutable.");
    const [privateCandidateBoundary] = await sql<{ acquisitions: number; candidates: number; runs: number; sources: number; versions: number }[]>`
      SELECT (SELECT count(*)::int FROM source_candidates
          WHERE (platform, external_id) IN (('example.invalid', 'manual-42'), ('fixture.thingiverse.invalid', 'fixture-7'))) AS candidates,
        (SELECT count(*)::int FROM source_candidate_versions AS version
          INNER JOIN source_candidates AS candidate ON candidate.id = version.candidate_id
          WHERE (candidate.platform, candidate.external_id) IN (('example.invalid', 'manual-42'), ('fixture.thingiverse.invalid', 'fixture-7'))) AS versions,
        (SELECT count(*)::int FROM source_candidate_acquisitions AS acquisition
          INNER JOIN source_candidates AS candidate ON candidate.id = acquisition.candidate_id
          WHERE (candidate.platform, candidate.external_id) IN (('example.invalid', 'manual-42'), ('fixture.thingiverse.invalid', 'fixture-7'))) AS acquisitions,
        (SELECT count(*)::int FROM source_adapter_runs WHERE public_id LIKE 'src_fixture_run_%') AS runs,
        (SELECT count(*)::int FROM sources WHERE canonical_url IN ('https://example.invalid/manual/42', 'https://example.invalid/fixture/7')) AS sources
    `;
    if (privateCandidateBoundary?.candidates !== 2 || privateCandidateBoundary.versions !== 4
      || privateCandidateBoundary.acquisitions !== 6 || privateCandidateBoundary.runs !== 3
      || privateCandidateBoundary.sources !== 0) {
      throw new Error(`Private candidate boundary failed: ${JSON.stringify(privateCandidateBoundary)}.`);
    }

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
      fitmentPublishedAt: string;
    }[]>`
      SELECT
        design_id AS "designId",
        revision_id AS "revisionId",
        source_id AS "sourceId",
        component_id AS "componentId",
        model_id AS "modelId",
        fitment_slug AS "fitmentSlug",
        fitment_published_at AS "fitmentPublishedAt"
      FROM public_catalogue_fitments
      WHERE fitment_id = ${prepared.fitmentId}
    `;
    if (!publishedGraph) throw new Error("Published catalogue graph fixture was not found.");

    await sql`UPDATE source_link_check_jobs SET status = 'pending', lease_token = NULL, lease_owner = NULL,
      lease_expires_at = NULL, next_check_at = clock_timestamp() + interval '1 day'`;
    await sql`UPDATE source_link_check_jobs SET next_check_at = clock_timestamp() - interval '1 second'
      WHERE source_id = ${publishedGraph.sourceId}`;
    const competingSql = postgres(databaseUrl, { prepare: false, max: 1 });
    type LinkClaim = { jobId: string; leaseToken: string; sourceId: string };
    let competingClaims: LinkClaim[][];
    try {
      competingClaims = await Promise.all([
        sql<LinkClaim[]>`SELECT job_id AS "jobId", lease_token AS "leaseToken", source_id AS "sourceId"
          FROM public.claim_source_link_check_jobs('database-gate-a', 1, 120)`,
        competingSql<LinkClaim[]>`SELECT job_id AS "jobId", lease_token AS "leaseToken", source_id AS "sourceId"
          FROM public.claim_source_link_check_jobs('database-gate-b', 1, 120)`,
      ]);
    } finally {
      await competingSql.end();
    }
    const claimedOnce = competingClaims.flat();
    if (claimedOnce.length !== 1 || claimedOnce[0]?.sourceId !== publishedGraph.sourceId) {
      throw new Error(`Concurrent link workers did not claim exactly once: ${JSON.stringify(competingClaims)}.`);
    }
    await sql`UPDATE source_link_check_jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${claimedOnce[0].jobId}`;
    const recoveredClaims = await sql<LinkClaim[]>`
      SELECT job_id AS "jobId", lease_token AS "leaseToken", source_id AS "sourceId"
      FROM public.claim_source_link_check_jobs('database-gate-restarted', 1, 120)
    `;
    if (recoveredClaims.length !== 1 || recoveredClaims[0]?.jobId !== claimedOnce[0].jobId
      || recoveredClaims[0].leaseToken === claimedOnce[0].leaseToken) {
      throw new Error("Expired database-clock link lease was not safely recovered after process restart.");
    }
    const recoveredClaim = recoveredClaims[0];
    if (!recoveredClaim) throw new Error("Recovered link claim disappeared after validation.");

    await sql`UPDATE sources SET content_checksum = ${fixtureDigest("published-source-before-change")}
      WHERE id = ${publishedGraph.sourceId}`;
    const contentChangeRollbackMarker = "WP10_CONTENT_CHANGE_ROLLBACK";
    let contentChangeRolledBack = false;
    try {
      await sql.begin(async (transaction) => {
        await transaction`SELECT public.complete_source_link_check(
          ${recoveredClaim.jobId}, ${recoveredClaim.leaseToken}, ${staff.id}, 200, 'healthy',
          ${"https://example.invalid/editorial/publishable-latch"}, 8, NULL, 0, NULL,
          ${fixtureDigest("published-source-after-change")}, 'req_source_content_changed'
        )`;
        const [contentChangeState] = await transaction<{
          fitmentStatus: string;
          sourceStatus: string;
          publicRows: number;
          searchRows: number;
          checksumAudits: number;
        }[]>`
          SELECT
            (SELECT publication_status::text FROM fitments WHERE id = ${prepared.fitmentId}) AS "fitmentStatus",
            (SELECT status FROM sources WHERE id = ${publishedGraph.sourceId}) AS "sourceStatus",
            (SELECT count(*)::int FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}) AS "publicRows",
            (SELECT count(*)::int FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}) AS "searchRows",
            (SELECT count(*)::int FROM audit_log WHERE request_id = 'req_source_content_changed'
              AND action = 'source.link_health.needs_review'
              AND after ->> 'status' = 'content_changed'
              AND after ->> 'contentChecksum' = ${fixtureDigest("published-source-after-change")}) AS "checksumAudits"
        `;
        if (contentChangeState?.fitmentStatus !== "needs_review" || contentChangeState.sourceStatus !== "content_changed"
          || contentChangeState.publicRows !== 0 || contentChangeState.searchRows !== 0
          || contentChangeState.checksumAudits !== 1) {
          throw new Error(`Changed source content did not trigger rights/claim review: ${JSON.stringify(contentChangeState)}.`);
        }
        throw new Error(contentChangeRollbackMarker);
      });
    } catch (error) {
      contentChangeRolledBack = error instanceof Error && error.message === contentChangeRollbackMarker;
    }
    if (!contentChangeRolledBack) throw new Error("Source content-change verification did not roll back cleanly.");

    const rollbackMarker = "WP10_REMOVAL_ROLLBACK";
    let removalTransactionRolledBack = false;
    try {
      await sql.begin(async (transaction) => {
        await transaction`SELECT public.complete_source_link_check(
          ${recoveredClaim.jobId}, ${recoveredClaim.leaseToken}, ${staff.id}, 404, 'removed', NULL,
          12, NULL, 0, NULL, NULL, 'req_source_link_removed'
        )`;
        const [removalState] = await transaction<{ fitmentStatus: string; sourceStatus: string; publicRows: number; searchRows: number; audits: number }[]>`
          SELECT
            (SELECT publication_status::text FROM fitments WHERE id = ${prepared.fitmentId}) AS "fitmentStatus",
            (SELECT status FROM sources WHERE id = ${publishedGraph.sourceId}) AS "sourceStatus",
            (SELECT count(*)::int FROM public_catalogue_fitments WHERE fitment_id = ${prepared.fitmentId}) AS "publicRows",
            (SELECT count(*)::int FROM public_search_documents WHERE entity_type = 'part' AND entity_id = ${prepared.fitmentId}) AS "searchRows",
            (SELECT count(*)::int FROM audit_log WHERE request_id = 'req_source_link_removed') AS audits
        `;
        if (removalState?.fitmentStatus !== "needs_review" || removalState.sourceStatus !== "removed"
          || removalState.publicRows !== 0 || removalState.searchRows !== 0 || removalState.audits !== 1) {
          throw new Error(`Confirmed removal did not atomically withdraw publication: ${JSON.stringify(removalState)}.`);
        }
        throw new Error(rollbackMarker);
      });
    } catch (error) {
      removalTransactionRolledBack = error instanceof Error && error.message === rollbackMarker;
    }
    if (!removalTransactionRolledBack) throw new Error("Source removal verification transaction did not roll back cleanly.");
    await sql`UPDATE source_link_check_jobs SET status = 'pending', lease_token = NULL, lease_owner = NULL,
      lease_expires_at = NULL, next_check_at = clock_timestamp() + interval '1 day'
      WHERE id = ${recoveredClaim.jobId}`;

    const [appendOnlyCheck] = await sql<{ id: string }[]>`
      INSERT INTO source_link_checks (job_id, source_id, checked_at, http_status, outcome, final_url,
        response_ms, redirect_hops, checked_by)
      VALUES (${recoveredClaim.jobId}, ${publishedGraph.sourceId}, clock_timestamp(), 200, 'healthy',
        ${"https://example.invalid/editorial/publishable-latch"}, 9, 0, ${staff.id}) RETURNING id
    `;
    if (!appendOnlyCheck) throw new Error("Append-only link-check fixture was not created.");
    let sourceCheckMutationRejected = false;
    try {
      await sql`UPDATE source_link_checks SET response_ms = 10 WHERE id = ${appendOnlyCheck.id}`;
    } catch (error) {
      sourceCheckMutationRejected = error instanceof Error && error.message.includes("append-only");
    }
    if (!sourceCheckMutationRejected) throw new Error("Source link-check evidence is not append-only.");

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

    const catalogueCleanupReference = new Date();
    const catalogueCleanupConsent = new Date(catalogueCleanupReference.getTime() - 10_000);
    const catalogueCleanupDeleted = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: catalogueCleanupConsent,
      consentedAt: catalogueCleanupConsent,
      contactEmail: undefined,
      contactRetentionExpiresAt: undefined,
      contentFingerprint: "catalogue-cleanup-delete-content".padEnd(64, "0"),
      contributorKey: "catalogue-cleanup-delete-contributor".padEnd(64, "0"),
      idempotencyActorKey: "catalogue-cleanup-delete-actor".padEnd(64, "0"),
      idempotencyKeyHash: "catalogue-cleanup-delete-idempotency".padEnd(64, "0"),
      requestFingerprint: "catalogue-cleanup-delete-request".padEnd(64, "0"),
      retentionExpiresAt: new Date(catalogueCleanupReference.getTime() - 2_000),
    }, database);
    const catalogueCleanupRedacted = await submissionRepository.persistAnonymousSubmission({
      ...baseSubmission,
      challengeVerifiedAt: catalogueCleanupConsent,
      consentedAt: catalogueCleanupConsent,
      contactEmail: "catalogue-cleanup-private@example.invalid",
      contactRetentionExpiresAt: new Date(catalogueCleanupReference.getTime() - 2_000),
      contentFingerprint: "catalogue-cleanup-redact-content".padEnd(64, "0"),
      contributorKey: "catalogue-cleanup-redact-contributor".padEnd(64, "0"),
      idempotencyActorKey: "catalogue-cleanup-redact-actor".padEnd(64, "0"),
      idempotencyKeyHash: "catalogue-cleanup-redact-idempotency".padEnd(64, "0"),
      requestFingerprint: "catalogue-cleanup-redact-request".padEnd(64, "0"),
      retentionExpiresAt: new Date(catalogueCleanupReference.getTime() + 60_000),
    }, database);
    const [publicCountsBeforeCleanup] = await sql<{ catalogue: number; search: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public_catalogue_fitments) AS catalogue,
        (SELECT count(*)::int FROM public_search_documents) AS search
    `;
    const catalogueCleanup = await submissionRepository.cleanupExpiredAnonymousSubmissions(database, 2);
    const [publicCountsAfterCleanup] = await sql<{ catalogue: number; search: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public_catalogue_fitments) AS catalogue,
        (SELECT count(*)::int FROM public_search_documents) AS search
    `;
    if (
      catalogueCleanup.deletedSubmissions !== 1
      || catalogueCleanup.deletedIntakes !== 1
      || catalogueCleanup.deletedContacts !== 1
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
      liveIntakes: number;
      redactedContacts: number;
      retainedParent: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM submissions WHERE id = ${catalogueCleanupDeleted.id}) AS deleted,
        (SELECT count(*)::int FROM submissions WHERE id = ${catalogueCleanupRedacted.id}) AS "retainedParent",
        (SELECT count(*)::int FROM submission_idempotency_bindings
          WHERE id = ${catalogueCleanupRedacted.intakeId}) AS "liveIntakes",
        (SELECT count(*)::int FROM submission_intake_contacts
          WHERE intake_id = ${catalogueCleanupRedacted.intakeId}) AS "redactedContacts"
    `;
    if (
      !catalogueCleanupPrivateEvidence
      || catalogueCleanupPrivateEvidence.deleted !== 0
      || catalogueCleanupPrivateEvidence.retainedParent !== 1
      || catalogueCleanupPrivateEvidence.liveIntakes !== 1
      || catalogueCleanupPrivateEvidence.redactedContacts !== 0
    ) {
      throw new Error("Catalogue-safe cleanup did not erase its private submission fixtures.");
    }

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
      publishedAt: new Date(new Date(publishedGraph.fitmentPublishedAt).getTime() + 1_000),
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
      publishedAt: new Date(new Date(publishedGraph.fitmentPublishedAt).getTime() + 2_000),
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

async function provisionSourceServiceRole(
  owner: ReturnType<typeof postgres>,
  databaseUrl: string,
): Promise<string> {
  const password = `rp_source_${randomBytes(24).toString("hex")}`;
  await owner.unsafe(`ALTER ROLE repairprint_source_service WITH LOGIN PASSWORD '${password}'`);
  const serviceUrl = new URL(databaseUrl);
  serviceUrl.username = "repairprint_source_service";
  serviceUrl.password = password;
  return serviceUrl.toString();
}

type PersistFixtureInput = Partial<PersistAnonymousSubmissionInput> & Pick<
  PersistAnonymousSubmissionInput,
  | "challengeVerifiedAt"
  | "consentedAt"
  | "contentFingerprint"
  | "contributorKey"
  | "idempotencyActorKey"
  | "idempotencyKeyHash"
  | "kind"
  | "payload"
  | "retentionExpiresAt"
  | "retentionPolicyVersion"
  | "requestFingerprint"
>;

function completePersistFixture(input: PersistFixtureInput): PersistAnonymousSubmissionInput {
  const contactPresent = Boolean(input.contactEmail);
  return {
    ...input,
    contactConsentVersion: input.contactConsentVersion ?? CONTACT_CONSENT_VERSION,
    contactDigest: contactPresent
      ? fixtureDigest(input.contactDigest ?? `contact:${input.contactEmail}`)
      : undefined,
    contactPresent,
    contactRetentionExpiresAt: contactPresent ? input.contactRetentionExpiresAt : undefined,
    contentFingerprint: fixtureDigest(input.contentFingerprint),
    contributionConsent: input.contributionConsent ?? true,
    contributorKey: fixtureDigest(input.contributorKey),
    contributorTermsVersion: input.contributorTermsVersion ?? CONTRIBUTOR_TERMS_VERSION,
    emailFollowUpConsent: input.emailFollowUpConsent ?? contactPresent,
    hmacVersion: input.hmacVersion ?? SUBMISSION_HMAC_ALGORITHM_VERSION,
    idempotencyActorKey: fixtureDigest(input.idempotencyActorKey),
    idempotencyKeyHash: fixtureDigest(input.idempotencyKeyHash),
    privacyConsent: input.privacyConsent ?? true,
    privacyNoticeVersion: input.privacyNoticeVersion ?? PRIVACY_NOTICE_VERSION,
    requestFingerprint: fixtureDigest(input.requestFingerprint),
    semanticPayload: input.semanticPayload ?? semanticSubmissionPayload(input.kind, input.payload),
  };
}

function fixtureDigest(value: string): string {
  return /^[0-9a-f]{64}$/u.test(value)
    ? value
    : createHash("sha256").update(value, "utf8").digest("hex");
}

function generateSubmissionTestHmacSecret(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomBytes(32).toString("hex");
    try {
      parseSubmissionHmacSecret(candidate);
      return candidate;
    } catch {
      // Regenerate the exceptionally unlikely disallowed/repeating test key.
    }
  }
  throw new Error("Could not generate an ephemeral valid submission HMAC test key.");
}

function setsEqual<T>(actual: ReadonlySet<T>, expected: ReadonlySet<T>): boolean {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
