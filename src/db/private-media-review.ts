import "server-only";

import { sql } from "drizzle-orm";

export type ReviewMediaObject = Readonly<{ assetId: string; height: number; objectPath: string; width: number }>;
export type IntakeReviewMedia = Readonly<{
  assetId: string;
  height: number;
  moderationStatus: string;
  purpose: string;
  publicDisplayConsent: boolean;
  hasRedactedDerivative: boolean;
  width: number;
}>;

export async function listPrivateReviewMedia(input: Readonly<{
  actorId: string;
  intakeId: string;
  requestId: string;
  submissionId: string;
}>): Promise<readonly IntakeReviewMedia[]> {
  const { db } = await import("./client");
  return db.transaction(async (tx) => {
    const rows = await tx.execute<IntakeReviewMedia>(sql`
      SELECT asset.id AS "assetId", asset.source_width AS width, asset.source_height AS height,
        asset.moderation_status AS "moderationStatus", session.purpose,
        consent.public_display_consent AS "publicDisplayConsent",
        EXISTS (
          SELECT 1 FROM private_media_derivatives AS redacted
          WHERE redacted.asset_id = asset.id AND redacted.kind = 'redacted'
        ) AS "hasRedactedDerivative"
      FROM submission_idempotency_bindings AS intake
      INNER JOIN private_media_upload_sessions AS session ON session.intake_id = intake.id
      INNER JOIN private_media_assets AS asset ON asset.session_id = session.id AND asset.intake_id = intake.id
      INNER JOIN private_media_consents AS consent ON consent.session_id = session.id AND consent.intake_id = intake.id
      WHERE intake.id = ${input.intakeId} AND intake.submission_id = ${input.submissionId}
        AND session.status = 'processed' AND asset.moderation_status NOT IN ('rejected', 'expired')
        AND asset.retention_deadline > pg_catalog.clock_timestamp()
      ORDER BY session.created_at, asset.id
    `);
    await tx.execute(sql`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${input.actorId}, 'private_media.discover', 'submission', ${input.submissionId}, NULL,
        ${JSON.stringify({ intakeId: input.intakeId, assetCount: rows.length })}::jsonb,
        'Private intake media discovery', ${input.requestId})
    `);
    return Object.freeze(rows.map((row) => Object.freeze(row)));
  });
}

export async function getPrivateReviewMedia(assetId: string, kind: "sanitized_master" | "thumbnail" | "redacted"): Promise<ReviewMediaObject> {
  const { db } = await import("./client");
  const rows = await db.execute<ReviewMediaObject>(sql`
    SELECT asset.id AS "assetId", derivative.object_path AS "objectPath", derivative.width, derivative.height
    FROM private_media_assets AS asset
    INNER JOIN private_media_derivatives AS derivative ON derivative.asset_id = asset.id AND derivative.kind = ${kind}
    WHERE asset.id = ${assetId} AND asset.moderation_status NOT IN ('rejected', 'expired')
      AND asset.retention_deadline > pg_catalog.clock_timestamp()
    LIMIT 1
  `);
  if (!rows[0]) throw new Error("PRIVATE_MEDIA_NOT_FOUND");
  return Object.freeze(rows[0]);
}

export async function auditPrivateMediaView(input: Readonly<{ actorId: string; assetId: string; kind: string; requestId: string }>): Promise<void> {
  const { db } = await import("./client");
  await db.execute(sql`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
    VALUES (${input.actorId}, 'private_media.view', 'private_media_asset', ${input.assetId}, NULL,
      ${JSON.stringify({ derivativeKind: input.kind })}::jsonb, 'Evidence review access', ${input.requestId})
  `);
}

export async function reservePrivateMediaRedactionObject(input: Readonly<{
  assetId: string;
  objectPath: string;
}>): Promise<void> {
  const { db } = await import("./client");
  await db.transaction(async (tx) => {
    const eligible = await tx.execute<{ sessionId: string }>(sql`
      SELECT session.id AS "sessionId"
      FROM private_media_assets AS asset
      INNER JOIN private_media_upload_sessions AS session ON session.id = asset.session_id
      WHERE asset.id = ${input.assetId} AND session.status = 'processed'
        AND asset.moderation_status NOT IN ('rejected', 'expired')
        AND asset.retention_deadline > pg_catalog.clock_timestamp()
        AND (session.cleanup_lease_expires_at IS NULL OR session.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
        AND NOT EXISTS (
          SELECT 1 FROM private_media_derivatives AS derivative
          WHERE derivative.asset_id = asset.id AND derivative.kind = 'redacted'
        )
      FOR UPDATE OF asset, session
    `);
    if (!eligible[0]) throw new Error("PRIVATE_MEDIA_NOT_FOUND");
    await tx.execute(sql`
      INSERT INTO private_media_pending_objects (session_id, kind, object_path, delete_after)
      VALUES (${eligible[0].sessionId}, 'redacted', ${input.objectPath},
        pg_catalog.clock_timestamp() + interval '5 minutes')
      ON CONFLICT (object_path) DO NOTHING
    `);
    const manifest = await tx.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM private_media_pending_objects
      WHERE session_id = ${eligible[0].sessionId} AND kind = 'redacted' AND object_path = ${input.objectPath}
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
    `);
    if (manifest[0]?.count !== 1) throw new Error("MEDIA_OBJECT_MANIFEST_UNAVAILABLE");
  });
}

export async function recordPrivateMediaRedaction(input: Readonly<{
  actorId: string; assetId: string; checksum: string; height: number; objectPath: string; reason: string;
  rectangles: readonly Readonly<{ x: number; y: number; width: number; height: number }>[];
  rectanglesHash: string; requestId: string; width: number; bytes: number;
}>): Promise<void> {
  const { db } = await import("./client");
  await db.transaction(async (tx) => {
    const eligible = await tx.execute<{ id: string; sessionId: string }>(sql`
      SELECT asset.id, session.id AS "sessionId"
      FROM private_media_assets AS asset
      INNER JOIN private_media_upload_sessions AS session ON session.id = asset.session_id
      WHERE asset.id = ${input.assetId}
        AND session.status = 'processed'
        AND asset.moderation_status NOT IN ('rejected', 'expired')
        AND asset.retention_deadline > pg_catalog.clock_timestamp()
        AND (session.cleanup_lease_expires_at IS NULL OR session.cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      FOR UPDATE OF asset, session
    `);
    if (!eligible[0]) throw new Error("PRIVATE_MEDIA_NOT_FOUND");
    const derivative = await tx.execute<{ id: string }>(sql`
      INSERT INTO private_media_derivatives (asset_id, kind, object_path, checksum_sha256, mime_type, bytes, width, height)
      VALUES (${input.assetId}, 'redacted', ${input.objectPath}, ${input.checksum}, 'image/webp', ${input.bytes}, ${input.width}, ${input.height})
      ON CONFLICT (asset_id, kind) DO NOTHING
      RETURNING id
    `);
    if (!derivative[0]) throw new Error("MEDIA_REDACTION_ALREADY_EXISTS");
    const versionRows = await tx.execute<{ version: number }>(sql`SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM private_media_redactions WHERE asset_id = ${input.assetId}`);
    await tx.execute(sql`
      INSERT INTO private_media_redactions (asset_id, version, rectangles, rectangles_hash, derivative_id, staff_id, reason)
      VALUES (${input.assetId}, ${versionRows[0]!.version}, ${JSON.stringify(input.rectangles)}::jsonb, ${input.rectanglesHash}, ${derivative[0]!.id}, ${input.actorId}, ${input.reason})
    `);
    await tx.execute(sql`UPDATE private_media_assets SET moderation_status = 'approved_private', reviewed_by = ${input.actorId}, reviewed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp() WHERE id = ${input.assetId}`);
    const released = await tx.execute<{ id: string }>(sql`
      DELETE FROM private_media_pending_objects
      WHERE session_id = ${eligible[0].sessionId} AND kind = 'redacted' AND object_path = ${input.objectPath}
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= pg_catalog.clock_timestamp())
      RETURNING id
    `);
    if (released.length !== 1) throw new Error("MEDIA_OBJECT_MANIFEST_UNAVAILABLE");
    await tx.execute(sql`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${input.actorId}, 'private_media.redact', 'private_media_asset', ${input.assetId}, NULL,
        ${JSON.stringify({ rectanglesHash: input.rectanglesHash, version: versionRows[0]!.version })}::jsonb, ${input.reason}, ${input.requestId})
    `);
  });
}
