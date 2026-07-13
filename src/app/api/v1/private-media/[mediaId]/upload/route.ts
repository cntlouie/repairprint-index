import { type NextRequest } from "next/server";

import { findPrivateMediaSession, markPrivateMediaUploaded } from "@/db/private-media";
import { issueMediaCapability, mediaError, mediaJson, readBoundedMediaBody, requireMediaCapability } from "@/lib/private-media-api";
import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { createPrivateMediaStorage } from "@/lib/private-media-storage";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, context: { params: Promise<{ mediaId: string }> }) {
  try {
    const { mediaId } = await context.params;
    const config = resolvePrivateMediaConfig();
    if (process.env.DEMO_MODE !== "false") return mediaJson({ mediaId, status: "simulated", stored: false });
    const claims = requireMediaCapability(request, mediaId, "upload", config);
    const { getSubmissionDatabase } = await import("@/db/submission-client");
    const database = await getSubmissionDatabase();
    const session = await findPrivateMediaSession(mediaId, database);
    if (!session || session.status !== "issued") throw new Error("MEDIA_UPLOAD_NOT_AVAILABLE");
    const bytes = await readBoundedMediaBody(request, session.claimedBytes);
    const storage = createPrivateMediaStorage(config);
    try { await storage.upload(config.quarantineBucket, session.quarantineObjectPath, bytes, session.claimedMimeType); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "MEDIA_OBJECT_EXISTS") throw error;
      const existing = await storage.download(config.quarantineBucket, session.quarantineObjectPath);
      if (existing.length !== bytes.length || existing.some((value, index) => value !== bytes[index])) throw new Error("MEDIA_OBJECT_COLLISION");
    }
    try { await markPrivateMediaUploaded(mediaId, claims.nonce, database); }
    catch (error) {
      const current = await findPrivateMediaSession(mediaId, database);
      if (current?.status === "issued") await storage.remove(config.quarantineBucket, [session.quarantineObjectPath]);
      throw error;
    }
    const finalize = issueMediaCapability(mediaId, "finalize", config);
    return mediaJson({ mediaId, status: "uploaded", finalizeCapability: finalize.token, expiresAt: finalize.expiresAt.toISOString() });
  } catch (error) { return mediaError(error); }
}
