import type { NextRequest } from "next/server";
import { z } from "zod";

import { areSafeSourceMetadataFields, SOURCE_SAFE_METADATA_FIELDS } from "@/domain/source-policy";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { sanitizeSourceOperationError } from "@/lib/source-errors";

export const dynamic = "force-dynamic";

const policySchema = z.object({
  platform: z.string().trim().min(1).max(80),
  policyVersion: z.string().trim().min(1).max(120),
  termsUrl: z.url({ protocol: /^https$/ }),
  termsChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  termsCheckedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  decision: z.enum(["api", "creator_submission", "written_permission", "link_only", "blocked"]),
  allowedFields: z.array(z.enum(SOURCE_SAFE_METADATA_FIELDS)).min(1).max(SOURCE_SAFE_METADATA_FIELDS.length)
    .refine(areSafeSourceMetadataFields, "Source policy fields exceed the global safe metadata ceiling."),
  automationAllowed: z.boolean(),
  commercialUseAllowed: z.boolean().nullable(),
  adapterEnabled: z.boolean(),
  evidence: z.record(z.string().min(1).max(80), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  reason: z.string().trim().min(8).max(500),
});

export async function GET(request: NextRequest) {
  try {
    await authorizeAdminRequest(request, "policy:manage");
    const { databaseClient } = await import("@/db/client");
    const reviews = await databaseClient`
      SELECT id, platform, policy_version AS "policyVersion", terms_url AS "termsUrl",
        terms_checksum AS "termsChecksum", terms_checked_at AS "termsCheckedAt", expires_at AS "expiresAt",
        decision, allowed_fields AS "allowedFields", automation_allowed AS "automationAllowed",
        commercial_use_allowed AS "commercialUseAllowed", adapter_enabled AS "adapterEnabled",
        reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"
      FROM public.source_policy_reviews
      ORDER BY reviewed_at DESC, id DESC LIMIT 100
    `;
    return adminJson({ reviews });
  } catch (error) {
    return adminError(sanitizeSourceOperationError(error), request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await authorizeAdminRequest(request, "policy:manage");
    const body = await parseAdminBody(request, policySchema);
    const { databaseClient } = await import("@/db/client");
    const [result] = await databaseClient<{ reviewId: string }[]>`
      SELECT public.record_source_policy_review(
        ${body.platform}, ${body.policyVersion}, ${body.termsUrl}, ${body.termsChecksum},
        ${body.termsCheckedAt}::text::timestamptz, ${body.expiresAt}::text::timestamptz, ${body.decision},
        ${JSON.stringify(body.allowedFields)}::text::jsonb, ${body.automationAllowed}, ${body.commercialUseAllowed},
        ${body.adapterEnabled}, ${JSON.stringify(body.evidence)}::text::jsonb, ${staff.id}, ${body.reason},
        ${request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`}
      ) AS "reviewId"
    `;
    if (!result) throw new Error("SOURCE_POLICY_REVIEW_FAILED");
    return adminJson({ policyReview: result }, 201);
  } catch (error) {
    return adminError(sanitizeSourceOperationError(error), request);
  }
}
