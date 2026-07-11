import type { NextRequest } from "next/server";

import { listEditorialQueue } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await authorizeAdminRequest(request, "draft:write");
    const { db } = await import("@/db/client");
    return adminJson(await listEditorialQueue(db));
  } catch (error) {
    return adminError(error, request);
  }
}
