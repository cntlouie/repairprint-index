import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import sharp from "sharp";
import { z } from "zod";

import { validateRedactionRectangles } from "@/domain/private-media";
import { getPrivateReviewMedia, recordPrivateMediaRedaction } from "@/db/private-media-review";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { mediaChecksum, redactPrivateMedia } from "@/lib/private-media-processing";
import { createPrivateMediaStorage } from "@/lib/private-media-storage";

const bodySchema = z.object({ reason: z.string().trim().min(8).max(1000), rectangles: z.array(z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() })).min(1).max(32) });
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "evidence:review");
    const assetId = z.uuid().parse((await context.params).id);
    const body = await parseAdminBody(request, bodySchema);
    const source = await getPrivateReviewMedia(assetId, "sanitized_master");
    const rectangles = validateRedactionRectangles(body.rectangles, source);
    const rectanglesHash = createHash("sha256").update(JSON.stringify(rectangles)).digest("hex");
    const config = resolvePrivateMediaConfig();
    const storage = createPrivateMediaStorage(config);
    const original = await storage.download(config.privateBucket, source.objectPath);
    const redacted = await redactPrivateMedia(original, rectangles);
    const checksum = mediaChecksum(redacted);
    const path = `${source.objectPath.slice(0, source.objectPath.lastIndexOf("/"))}/redacted-${checksum}.webp`;
    await storage.upload(config.privateBucket, path, redacted, "image/webp");
    try {
      const metadata = await sharp(redacted).metadata();
      await recordPrivateMediaRedaction({ actorId: actor.id, assetId, checksum, height: metadata.height!, width: metadata.width!, objectPath: path, bytes: redacted.length, rectangles, rectanglesHash, reason: body.reason, requestId: request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}` });
    } catch (error) { await storage.remove(config.privateBucket, [path]); throw error; }
    return adminJson({ assetId, status: "approved_private", rectanglesHash });
  } catch (error) { return adminError(error, request); }
}
