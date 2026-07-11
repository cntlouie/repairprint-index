import type { NextRequest } from "next/server";

import { publishCreatorSubmission } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { publishCaseSchema } from "@/lib/admin-schemas";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "publication:publish");
    const input = await parseAdminBody(request, publishCaseSchema);
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    return adminJson(await publishCreatorSubmission(db, id, actor, input));
  } catch (error) {
    return adminError(error, request);
  }
}
