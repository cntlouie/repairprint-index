import type { NextRequest } from "next/server";

import { getEditorialCasePreview } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await authorizeAdminRequest(request, "draft:write");
    const { id } = await context.params;
    const { db } = await import("@/db/client");
    return adminJson(await getEditorialCasePreview(db, id));
  } catch (error) {
    return adminError(error, request);
  }
}
