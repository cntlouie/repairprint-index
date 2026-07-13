import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import sharp from "sharp";

import { claimPrivateMediaProcessing, completePrivateMediaProcessing, confirmPrivateMediaQuarantineDeleted, markPrivateMediaQuarantineCleanupPending, rejectPrivateMediaProcessing } from "@/db/private-media";
import { mediaError, mediaJson, requireMediaCapability } from "@/lib/private-media-api";
import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { mediaChecksum, processPrivateMedia } from "@/lib/private-media-processing";
import { createPrivateMediaStorage } from "@/lib/private-media-storage";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ mediaId: string }> }) {
  let claimed: Awaited<ReturnType<typeof claimPrivateMediaProcessing>> | undefined;
  let committed = false;
  try {
    const { mediaId } = await context.params;
    const config = resolvePrivateMediaConfig();
    if (process.env.DEMO_MODE !== "false") return mediaJson({ mediaId, status: "simulated", stored: false });
    requireMediaCapability(request, mediaId, "finalize", config);
    const { getSubmissionDatabase } = await import("@/db/submission-client");
    const database = await getSubmissionDatabase();
    claimed = await claimPrivateMediaProcessing(mediaId, database);
    const storage = createPrivateMediaStorage(config);
    const source = await storage.download(config.quarantineBucket, claimed.quarantineObjectPath);
    const processed = await processPrivateMedia(source, { bytes: claimed.claimedBytes, extension: claimed.claimedExtension, mimeType: claimed.claimedMimeType });
    const shard = createHash("sha256").update(claimed.publicId).digest("hex").slice(0, 2);
    const base = `private/${shard}/${claimed.publicId}`;
    const masterPath = `${base}/master-${processed.masterChecksum}.webp`;
    const thumbnailPath = `${base}/thumbnail-${processed.thumbnailChecksum}.webp`;
    const written: string[] = [];
    try {
      await uploadDerivative(storage, config.privateBucket, masterPath, processed.master, processed.masterChecksum); written.push(masterPath);
      await uploadDerivative(storage, config.privateBucket, thumbnailPath, processed.thumbnail, processed.thumbnailChecksum); written.push(thumbnailPath);
      const thumbMeta = await sharp(processed.thumbnail).metadata();
      await completePrivateMediaProcessing({ session: claimed, sourceChecksum: processed.sourceChecksum, detectedMimeType: processed.detectedMimeType,
        width: processed.width, height: processed.height,
        master: { path: masterPath, checksum: processed.masterChecksum, bytes: processed.master.length, width: processed.width, height: processed.height },
        thumbnail: { path: thumbnailPath, checksum: processed.thumbnailChecksum, bytes: processed.thumbnail.length, width: thumbMeta.width!, height: thumbMeta.height! },
      }, database);
      committed = true;
    } catch (error) { await storage.remove(config.privateBucket, written); throw error; }
    await storage.remove(config.quarantineBucket, [claimed.quarantineObjectPath]);
    return mediaJson({ mediaId, status: "processed" });
  } catch (error) {
    if (claimed) {
      try {
        const { getSubmissionDatabase } = await import("@/db/submission-client");
        const database = await getSubmissionDatabase();
        if (!committed) {
          const code = error instanceof Error && error.message.startsWith("MEDIA_") ? error.message : "MEDIA_PROCESSING_FAILED";
          await rejectPrivateMediaProcessing(claimed.id, claimed.leaseToken, code, database);
        }
        const config = resolvePrivateMediaConfig();
        try {
          await createPrivateMediaStorage(config).remove(config.quarantineBucket, [claimed.quarantineObjectPath]);
          if (!committed) await confirmPrivateMediaQuarantineDeleted(claimed.id, database);
        } catch {
          if (committed) await markPrivateMediaQuarantineCleanupPending(claimed.id, database);
          // A rejected row already carries the pending marker written in the same transition.
        }
      } catch { /* rows remain for bounded cleanup retry */ }
    }
    return mediaError(error);
  }
}

async function uploadDerivative(storage: ReturnType<typeof createPrivateMediaStorage>, bucket: string, path: string, bytes: Uint8Array, checksum: string): Promise<void> {
  try { await storage.upload(bucket, path, bytes, "image/webp"); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "MEDIA_OBJECT_EXISTS") throw error;
    const existing = await storage.download(bucket, path);
    if (mediaChecksum(existing) !== checksum) throw new Error("MEDIA_OBJECT_COLLISION");
  }
}
