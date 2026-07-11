import type { NextRequest } from "next/server";

import { prepareCreatorSubmission } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { prepareCreatorCaseSchema } from "@/lib/admin-schemas";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "draft:write");
    const input = await parseAdminBody(request, prepareCreatorCaseSchema);
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    return adminJson(await prepareCreatorSubmission(db, id, actor, input));
  } catch (error) {
    return adminError(error, request);
  }
}
