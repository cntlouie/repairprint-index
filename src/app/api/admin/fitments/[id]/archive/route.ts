import type { NextRequest } from "next/server";

import { archiveFitment } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { archiveFitmentSchema } from "@/lib/admin-schemas";
import { describeCatalogueCacheFailure, runCatalogueMutationWithInvalidation } from "@/lib/catalog-cache";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "archive:write");
    const input = await parseAdminBody(request, archiveFitmentSchema);
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    const result = await runCatalogueMutationWithInvalidation(() => archiveFitment(db, id, actor, input));
    return adminJson(result);
  } catch (error) {
    const cacheFailure = describeCatalogueCacheFailure(error);
    if (cacheFailure) {
      const requestId = request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`;
      return adminJson({ error: { ...cacheFailure.error, requestId } }, cacheFailure.status);
    }
    return adminError(error, request);
  }
}
