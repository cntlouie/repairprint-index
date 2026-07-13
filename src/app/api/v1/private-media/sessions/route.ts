import { randomBytes } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { assertMediaConsent, assertPrivateMediaPurpose, canonicalMediaIdempotencyKey } from "@/domain/private-media";
import { createPrivateMediaSession } from "@/db/private-media";
import { issueMediaCapability, mediaError, mediaJson } from "@/lib/private-media-api";
import { resolvePrivateMediaConfig } from "@/lib/private-media-config";
import { assertSubmissionOrigin, submissionHmac, submissionIdempotencyActorKey, trustedSubmissionClientIp } from "@/lib/submission-security";

export const dynamic = "force-dynamic";

const schema = z.object({
  idempotencyKey: z.uuid(), receiptId: z.uuid(),
  kind: z.enum(["missing_part", "fit_confirmation", "design_submission"]),
  purpose: z.string(), claimedBytes: z.number().int().min(1).max(10 * 1024 * 1024),
  claimedMimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
  claimedExtension: z.enum(["jpg", "jpeg", "png", "webp", "avif"]),
  ownsOrHasPermission: z.literal(true), privateStorage: z.literal(true), derivativeProcessing: z.literal(true),
  publicDisplay: z.boolean().default(false), termsVersion: z.string(), privacyVersion: z.string(), retentionVersion: z.string(),
});

export async function POST(request: NextRequest) {
  try {
    assertSubmissionOrigin(request);
    const body = schema.parse(await request.json());
    const purpose = body.purpose;
    assertPrivateMediaPurpose(purpose);
    const config = resolvePrivateMediaConfig();
    const now = new Date();
    const consent = Object.freeze({
      acceptedAt: now, derivativeProcessing: true as const, ownsOrHasPermission: true as const,
      privateStorage: true as const, publicDisplay: body.publicDisplay,
      termsVersion: body.termsVersion, privacyVersion: body.privacyVersion, retentionVersion: body.retentionVersion,
      retentionDeadline: new Date(now.getTime() + config.retentionDays * 86_400_000),
    });
    assertMediaConsent(consent, now);
    if (body.termsVersion !== config.termsVersion || body.privacyVersion !== config.privacyVersion || body.retentionVersion !== config.retentionVersion) throw new Error("MEDIA_POLICY_VERSION_REQUIRED");
    if (process.env.DEMO_MODE !== "false") return mediaJson({ mediaId: `media_demo_${randomBytes(16).toString("base64url")}`, status: "simulated", stored: false });
    const provisionalId = `media_${randomBytes(24).toString("base64url")}`;
    const provisional = issueMediaCapability(provisionalId, "upload", config, now);
    const { getSubmissionDatabase } = await import("@/db/submission-client");
    const session = await createPrivateMediaSession({
      ...body, purpose, consent, capabilityNonce: provisional.nonce, capabilityExpiresAt: provisional.expiresAt,
      idempotencyActorKey: submissionIdempotencyActorKey(trustedSubmissionClientIp(request)),
      idempotencyKeyHash: submissionHmac("idempotency-key", canonicalMediaIdempotencyKey(body.idempotencyKey)),
    }, await getSubmissionDatabase());
    if (session.status === "processed") return mediaJson({ mediaId: session.publicId, status: "processed" });
    if (session.status === "processing") return mediaJson({ mediaId: session.publicId, status: "processing" }, 202);
    const operation = session.status === "uploaded" ? "finalize" : "upload";
    const capability = issueMediaCapability(session.publicId, operation, config, now, provisional.nonce);
    return mediaJson({ mediaId: session.publicId, status: session.status, [`${operation}Capability`]: capability.token, expiresAt: capability.expiresAt.toISOString() }, 201);
  } catch (error) { return mediaError(error); }
}
