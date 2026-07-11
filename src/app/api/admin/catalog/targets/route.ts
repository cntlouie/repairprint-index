import type { NextRequest } from "next/server";

import { createCatalogTargetDraft } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { catalogTargetDraftSchema } from "@/lib/admin-schemas";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = await authorizeAdminRequest(request, "draft:write");
    const input = await parseAdminBody(request, catalogTargetDraftSchema);
    const { db } = await import("@/db/client");
    return adminJson(await createCatalogTargetDraft(db, actor, input), 201);
  } catch (error) {
    return adminError(error, request);
  }
}
