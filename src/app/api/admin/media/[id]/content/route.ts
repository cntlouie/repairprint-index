import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auditPrivateMediaView, getPrivateReviewMedia } from "@/db/private-media-review";
import { adminError, authorizeAdminRequest } from "@/lib/admin-api";
import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { createPrivateMediaStorage } from "@/lib/private-media-storage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "evidence:review");
    const { id } = await context.params;
    const assetId = z.uuid().parse(id);
    const kind = z.enum(["sanitized_master", "thumbnail", "redacted"]).parse(request.nextUrl.searchParams.get("kind") ?? "thumbnail");
    const media = await getPrivateReviewMedia(assetId, kind);
    const config = resolvePrivateMediaConfig();
    const bytes = await createPrivateMediaStorage(config).download(config.privateBucket, media.objectPath);
    const requestId = request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`;
    await auditPrivateMediaView({ actorId: actor.id, assetId, kind, requestId });
    const responseBytes = Uint8Array.from(bytes);
    return new NextResponse(new Blob([responseBytes.buffer], { type: "image/webp" }), { status: 200, headers: { "cache-control": "private, no-store, max-age=0", "content-type": "image/webp", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" } });
  } catch (error) { return adminError(error, request); }
}
