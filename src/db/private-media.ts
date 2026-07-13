import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AnonymousSubmissionKind } from "@/domain/submissions";
import type { MediaConsent, PrivateMediaPurpose } from "@/domain/private-media";
import type * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

export type PrivateMediaSession = Readonly<{
  claimedBytes: number;
  claimedExtension: string;
  claimedMimeType: string;
  id: string;
  intakeId: string;
  publicId: string;
  quarantineObjectPath: string;
  status: string;
  finalizeCapabilityExpiresAt: Date | null;
  cleanupActive: boolean;
}>;

export async function createPrivateMediaSession(input: Readonly<{
  consent: MediaConsent;
  idempotencyActorKey: string;
  idempotencyKeyHash: string;
  kind: AnonymousSubmissionKind;
  purpose: PrivateMediaPurpose;
  receiptId: string;
  claimedBytes: number;
  claimedExtension: string;
  claimedMimeType: string;
  capabilityNonce: string;
  capabilityExpiresAt: Date;
}>, database: Database): Promise<PrivateMediaSession> {
  let stage = "TRANSACTION_BEGIN";
  try {
    return await database.transaction(async (tx) => {
    stage = "INTAKE_LOOKUP";
    const intakes = await tx.execute<{ id: string; retentionExpiresAt: Date }>(sql`
      SELECT intake.id, intake.retention_expires_at AS "retentionExpiresAt"
      FROM submission_idempotency_bindings AS intake
      INNER JOIN submissions AS parent ON parent.id = intake.submission_id AND parent.kind = intake.kind
        AND parent.receipt_id = intake.receipt_id AND parent.intake_version = intake.intake_version
        AND parent.hmac_version = intake.hmac_version
      WHERE intake.kind = ${input.kind} AND intake.idempotency_actor_key = ${input.idempotencyActorKey}
        AND intake.idempotency_key_hash = ${input.idempotencyKeyHash} AND intake.receipt_id = ${input.receiptId}
        AND intake.retention_expires_at > pg_catalog.clock_timestamp() AND parent.status IN ('pending', 'in_review')
    `);
    const intake = intakes[0];
    if (!intake) throw new Error("MEDIA_INTAKE_NOT_FOUND");
    const publicId = `media_${randomBytes(24).toString("base64url")}`;
    const objectId = randomBytes(24).toString("base64url");
    const path = `quarantine/${hash(objectId).slice(0, 2)}/${objectId}`;
    const nonceHash = hash(input.capabilityNonce);
    assertMediaSessionInsertParameters({
      capabilityExpiresAt: input.capabilityExpiresAt,
      claimedBytes: input.claimedBytes,
      claimedExtension: input.claimedExtension,
      claimedMimeType: input.claimedMimeType,
      intakeId: intake.id,
      kind: input.kind,
      nonceHash,
      path,
      publicId,
      purpose: input.purpose,
    });
    stage = "SESSION_INSERT";
    const sessions = await tx.execute<PrivateMediaSession>(sql`
      INSERT INTO private_media_upload_sessions (
        public_id, intake_id, kind, purpose, quarantine_object_path, claimed_mime_type,
        claimed_extension, claimed_bytes, capability_nonce_hash, capability_expires_at
      ) VALUES (${publicId}, ${intake.id}, ${input.kind}, ${input.purpose}, ${path},
        ${input.claimedMimeType}, ${input.claimedExtension}, ${input.claimedBytes}, ${nonceHash}, ${input.capabilityExpiresAt})
      ON CONFLICT (intake_id, purpose) DO NOTHING
      RETURNING id, intake_id AS "intakeId", public_id AS "publicId", quarantine_object_path AS "quarantineObjectPath",
        claimed_mime_type AS "claimedMimeType", claimed_extension AS "claimedExtension", claimed_bytes AS "claimedBytes", status,
        finalize_capability_expires_at AS "finalizeCapabilityExpiresAt"
    `);
    let session = sessions[0] ? { ...sessions[0], cleanupActive: false } : undefined;
    if (!session) {
      stage = "SESSION_LOOKUP";
      const existing = await tx.execute<PrivateMediaSession>(sql`
        SELECT id, intake_id AS "intakeId", public_id AS "publicId", quarantine_object_path AS "quarantineObjectPath",
          claimed_mime_type AS "claimedMimeType", claimed_extension AS "claimedExtension", claimed_bytes AS "claimedBytes", status,
          finalize_capability_expires_at AS "finalizeCapabilityExpiresAt",
          cleanup_lease_expires_at > pg_catalog.clock_timestamp() AS "cleanupActive"
        FROM private_media_upload_sessions WHERE intake_id = ${intake.id} AND purpose = ${input.purpose}
        FOR UPDATE
      `);
      session = existing[0];
      if (!session || session.claimedBytes !== input.claimedBytes || session.claimedMimeType !== input.claimedMimeType
        || session.claimedExtension !== input.claimedExtension || !["issued", "uploaded", "processing", "processed"].includes(session.status)) {
        throw new Error("MEDIA_PURPOSE_ALREADY_USED");
      }
      if (session.cleanupActive) throw new Error("MEDIA_CLEANUP_IN_PROGRESS");
      if (session.status === "issued") {
        stage = "UPLOAD_CAPABILITY_REFRESH";
        await tx.execute(sql`
          UPDATE private_media_upload_sessions SET capability_nonce_hash = ${nonceHash}, capability_expires_at = ${input.capabilityExpiresAt},
            updated_at = pg_catalog.clock_timestamp() WHERE id = ${session.id} AND status = 'issued'
              AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
        `);
      } else if (session.status === "uploaded") {
        stage = "FINALIZE_CAPABILITY_REFRESH";
        await tx.execute(sql`
          UPDATE private_media_upload_sessions SET capability_nonce_hash = ${nonceHash},
            finalize_capability_expires_at = ${input.capabilityExpiresAt}, updated_at = pg_catalog.clock_timestamp()
          WHERE id = ${session.id} AND status = 'uploaded'
            AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
        `);
        session = { ...session, finalizeCapabilityExpiresAt: input.capabilityExpiresAt };
      }
      return Object.freeze(session);
    }
    stage = "CONSENT_INSERT";
    await tx.execute(sql`
      INSERT INTO private_media_consents (
        session_id, intake_id, owns_or_has_permission, private_storage_consent,
        derivative_processing_consent, public_display_consent, terms_version, privacy_version,
        retention_version, accepted_at, retention_deadline
      ) VALUES (${session.id}, ${intake.id}, true, true, true, ${input.consent.publicDisplay},
        ${input.consent.termsVersion}, ${input.consent.privacyVersion}, ${input.consent.retentionVersion},
        ${input.consent.acceptedAt}, ${input.consent.retentionDeadline < intake.retentionExpiresAt ? input.consent.retentionDeadline : intake.retentionExpiresAt})
    `);
    return Object.freeze(session);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEDIA_SESSION_PARAMETER_")) throw error;
    throw new Error(`MEDIA_PERSISTENCE_${stage}_FAILED`, { cause: error });
  }
}

export async function findPrivateMediaSession(publicId: string, database: Database): Promise<PrivateMediaSession | null> {
  const rows = await database.execute<PrivateMediaSession>(sql`
    SELECT id, intake_id AS "intakeId", public_id AS "publicId", quarantine_object_path AS "quarantineObjectPath",
      claimed_mime_type AS "claimedMimeType", claimed_extension AS "claimedExtension", claimed_bytes AS "claimedBytes", status,
      finalize_capability_expires_at AS "finalizeCapabilityExpiresAt",
      cleanup_lease_expires_at > pg_catalog.clock_timestamp() AS "cleanupActive"
    FROM private_media_upload_sessions WHERE public_id = ${publicId} LIMIT 1
  `);
  return rows[0] ? Object.freeze(rows[0]) : null;
}

export async function markPrivateMediaUploaded(publicId: string, nonce: string, finalizeCapabilityExpiresAt: Date, database: Database): Promise<void> {
  const rows = await database.execute<{ id: string }>(sql`
    UPDATE private_media_upload_sessions SET status = 'uploaded', uploaded_at = pg_catalog.clock_timestamp(),
      finalize_capability_expires_at = ${finalizeCapabilityExpiresAt}, updated_at = pg_catalog.clock_timestamp()
    WHERE public_id = ${publicId} AND status = 'issued' AND capability_nonce_hash = ${hash(nonce)}
      AND capability_expires_at > pg_catalog.clock_timestamp()
      AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    RETURNING id
  `);
  if (!rows[0]) throw new Error("MEDIA_UPLOAD_NOT_AVAILABLE");
}

export async function claimPrivateMediaProcessing(publicId: string, database: Database): Promise<Readonly<PrivateMediaSession & { leaseToken: string; retentionDeadline: Date }>> {
  return database.transaction(async (tx) => {
    const leaseToken = randomUUID();
    const rows = await tx.execute<PrivateMediaSession & { retentionDeadline: Date }>(sql`
      UPDATE private_media_upload_sessions AS session
      SET status = 'processing', processing_lease_token = ${leaseToken},
        processing_lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes', updated_at = pg_catalog.clock_timestamp()
      FROM private_media_consents AS consent
      WHERE session.public_id = ${publicId} AND consent.session_id = session.id
        AND (session.status = 'uploaded' OR (session.status = 'processing' AND session.processing_lease_expires_at <= pg_catalog.clock_timestamp()))
        AND session.finalize_capability_expires_at > pg_catalog.clock_timestamp()
        AND (session.cleanup_lease_expires_at IS NULL OR session.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
        AND consent.retention_deadline > pg_catalog.clock_timestamp()
      RETURNING session.id, session.intake_id AS "intakeId", session.public_id AS "publicId",
        session.quarantine_object_path AS "quarantineObjectPath", session.claimed_mime_type AS "claimedMimeType",
        session.claimed_extension AS "claimedExtension", session.claimed_bytes AS "claimedBytes", session.status,
        consent.retention_deadline AS "retentionDeadline"
    `);
    const session = rows[0];
    if (!session) throw new Error("MEDIA_FINALIZE_NOT_AVAILABLE");
    return Object.freeze({ ...session, leaseToken });
  });
}

export async function completePrivateMediaProcessing(input: Readonly<{
  session: PrivateMediaSession & { leaseToken: string; retentionDeadline: Date };
  sourceChecksum: string;
  detectedMimeType: string;
  width: number;
  height: number;
  master: Readonly<{ path: string; checksum: string; bytes: number; width: number; height: number }>;
  thumbnail: Readonly<{ path: string; checksum: string; bytes: number; width: number; height: number }>;
}>, database: Database): Promise<string> {
  return database.transaction(async (tx) => {
    const assets = await tx.execute<{ id: string }>(sql`
      INSERT INTO private_media_assets (session_id, intake_id, checksum_sha256, detected_mime_type,
        source_bytes, source_width, source_height, retention_deadline)
      SELECT id, intake_id, ${input.sourceChecksum}, ${input.detectedMimeType}, claimed_bytes,
        ${input.width}, ${input.height}, ${input.session.retentionDeadline}
      FROM private_media_upload_sessions
      WHERE id = ${input.session.id} AND status = 'processing' AND processing_lease_token = ${input.session.leaseToken}
        AND processing_lease_expires_at > pg_catalog.clock_timestamp()
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
      RETURNING id
    `);
    const asset = assets[0];
    if (!asset) throw new Error("MEDIA_PROCESSING_LEASE_LOST");
    for (const [kind, derivative] of [["sanitized_master", input.master], ["thumbnail", input.thumbnail]] as const) {
      await tx.execute(sql`
        INSERT INTO private_media_derivatives (asset_id, kind, object_path, checksum_sha256, mime_type, bytes, width, height)
        VALUES (${asset.id}, ${kind}, ${derivative.path}, ${derivative.checksum}, 'image/webp', ${derivative.bytes}, ${derivative.width}, ${derivative.height})
        ON CONFLICT (asset_id, kind) DO NOTHING
      `);
    }
    const completed = await tx.execute<{ id: string }>(sql`
      UPDATE private_media_upload_sessions SET status = 'processed', processing_lease_token = NULL,
        processing_lease_expires_at = NULL, finalized_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${input.session.id} AND status = 'processing' AND processing_lease_token = ${input.session.leaseToken}
        AND processing_lease_expires_at > pg_catalog.clock_timestamp()
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      RETURNING id
    `);
    if (!completed[0]) throw new Error("MEDIA_PROCESSING_LEASE_LOST");
    return asset.id;
  });
}

export async function rejectPrivateMediaProcessing(sessionId: string, leaseToken: string, code: string, database: Database): Promise<void> {
  const rows = await database.execute<{ id: string }>(sql`
    UPDATE private_media_upload_sessions SET status = 'rejected', terminal_error_code = ${code},
      processing_lease_token = NULL, processing_lease_expires_at = NULL, finalized_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
    WHERE id = ${sessionId} AND status = 'processing' AND processing_lease_token = ${leaseToken}
      AND processing_lease_expires_at > pg_catalog.clock_timestamp()
      AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    RETURNING id
  `);
  if (!rows[0]) throw new Error("MEDIA_PROCESSING_LEASE_LOST");
}

export async function markPrivateMediaQuarantineCleanupPending(sessionId: string, database: Database): Promise<void> {
  const rows = await database.execute<{ id: string }>(sql`
    UPDATE private_media_upload_sessions SET terminal_error_code = 'MEDIA_QUARANTINE_DELETE_PENDING', updated_at = pg_catalog.clock_timestamp()
    WHERE id = ${sessionId} AND status = 'processed'
      AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    RETURNING id
  `);
  if (!rows[0]) throw new Error("MEDIA_CLEANUP_IN_PROGRESS");
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function assertMediaSessionInsertParameters(input: Readonly<Record<string, unknown>>): void {
  for (const [field, value] of Object.entries(input)) {
    const valid = value instanceof Date ? Number.isFinite(value.getTime()) : value !== undefined && value !== null;
    if (!valid) throw new Error(`MEDIA_SESSION_PARAMETER_${field.replaceAll(/[^a-z0-9]/gi, "_").toUpperCase()}_INVALID`);
  }
}
