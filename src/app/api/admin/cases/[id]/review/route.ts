import type { NextRequest } from "next/server";

import { reviewCreatorSubmission } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { reviewCreatorCaseSchema } from "@/lib/admin-schemas";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "evidence:review");
    const input = await parseAdminBody(request, reviewCreatorCaseSchema);
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    return adminJson(await reviewCreatorSubmission(db, id, actor, input));
  } catch (error) {
    return adminError(error, request);
  }
}
