import type { NextRequest } from "next/server";
import { z } from "zod";

import { sourceContentChecksum } from "@/domain/source-ingestion";
import { SOURCE_SAFE_METADATA_FIELDS } from "@/domain/source-policy";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { sanitizeSourceOperationError } from "@/lib/source-errors";

export const dynamic = "force-dynamic";

const manualCandidateSchema = z.object({
  platform: z.string().trim().min(1).max(80),
  externalId: z.string().trim().min(1).max(240),
  origin: z.enum(["manual", "creator_submission"]),
  policyReviewId: z.string().uuid(),
  payload: z.partialRecord(z.enum(SOURCE_SAFE_METADATA_FIELDS), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  retrievedAt: z.iso.datetime({ offset: true }),
});

export async function GET(request: NextRequest) {
  try {
    await authorizeAdminRequest(request, "draft:write");
    const { databaseClient } = await import("@/db/client");
    const candidates = await databaseClient`
      SELECT candidate.id, candidate.platform, candidate.external_id AS "externalId", candidate.origin,
        version.id AS "versionId", version.stage, version.content_checksum AS "contentChecksum",
        version.allowed_payload AS "allowedPayload", version.retrieved_at AS "retrievedAt"
      FROM public.source_candidates AS candidate
      INNER JOIN LATERAL (
        SELECT candidate_version.* FROM public.source_candidate_versions AS candidate_version
        WHERE candidate_version.candidate_id = candidate.id
        ORDER BY candidate_version.created_at DESC, candidate_version.id DESC LIMIT 1
      ) AS version ON true
      ORDER BY version.created_at DESC, candidate.id DESC LIMIT 100
    `;
    return adminJson({ candidates });
  } catch (error) {
    return adminError(sanitizeSourceOperationError(error), request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await authorizeAdminRequest(request, "draft:write");
    const body = await parseAdminBody(request, manualCandidateSchema);
    const { upsertPrivateSourceCandidate } = await import("@/db/source-operations");
    const result = await upsertPrivateSourceCandidate({
      platform: body.platform,
      externalId: body.externalId,
      origin: body.origin,
      contentChecksum: sourceContentChecksum(body.payload),
      allowedPayload: body.payload,
      adapterVersion: "manual-v1",
      policyReviewId: body.policyReviewId,
      retrievedAt: new Date(body.retrievedAt),
      actorId: staff.id,
      requestId: request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`,
    });
    return adminJson({ candidate: result }, result.versionCreated ? 201 : 200);
  } catch (error) {
    return adminError(sanitizeSourceOperationError(error), request);
  }
}
