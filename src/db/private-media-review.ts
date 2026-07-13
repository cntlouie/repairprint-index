import "server-only";

import { sql } from "drizzle-orm";

export type ReviewMediaObject = Readonly<{ assetId: string; height: number; objectPath: string; width: number }>;

export async function getPrivateReviewMedia(assetId: string, kind: "sanitized_master" | "thumbnail" | "redacted"): Promise<ReviewMediaObject> {
  const { db } = await import("./client");
  const rows = await db.execute<ReviewMediaObject>(sql`
    SELECT asset.id AS "assetId", derivative.object_path AS "objectPath", derivative.width, derivative.height
    FROM private_media_assets AS asset
    INNER JOIN private_media_derivatives AS derivative ON derivative.asset_id = asset.id AND derivative.kind = ${kind}
    WHERE asset.id = ${assetId} AND asset.moderation_status NOT IN ('rejected', 'expired')
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

export async function recordPrivateMediaRedaction(input: Readonly<{
  actorId: string; assetId: string; checksum: string; height: number; objectPath: string; reason: string;
  rectangles: readonly Readonly<{ x: number; y: number; width: number; height: number }>[];
  rectanglesHash: string; requestId: string; width: number; bytes: number;
}>): Promise<void> {
  const { db } = await import("./client");
  await db.transaction(async (tx) => {
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
    await tx.execute(sql`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, reason, request_id)
      VALUES (${input.actorId}, 'private_media.redact', 'private_media_asset', ${input.assetId}, NULL,
        ${JSON.stringify({ rectanglesHash: input.rectanglesHash, version: versionRows[0]!.version })}::jsonb, ${input.reason}, ${input.requestId})
    `);
  });
}
