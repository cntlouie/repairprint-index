import type { NextRequest } from "next/server";

import { moderateEvidence } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { moderateEvidenceSchema } from "@/lib/admin-schemas";
import { invalidatePublicCatalogueForFitment } from "@/lib/catalog-cache";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "evidence:review");
    const input = await parseAdminBody(request, moderateEvidenceSchema);
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    const result = await moderateEvidence(db, id, actor, input);
    await invalidatePublicCatalogueForFitment(result.fitmentId);
    return adminJson(result);
  } catch (error) {
    return adminError(error, request);
  }
}
