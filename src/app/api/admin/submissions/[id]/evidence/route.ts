import type { NextRequest } from "next/server";
import { z } from "zod";

import { getSubmissionEvidenceLink } from "@/db/editorial";
import { adminError, adminJson, authorizeAdminRequest } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await authorizeAdminRequest(request, "evidence:review");
    const { id } = await context.params;
    const submissionId = z.uuid().parse(id);
    const { getSubmissionDatabase } = await import("@/db/submission-client");
    return adminJson(await getSubmissionEvidenceLink(await getSubmissionDatabase(), submissionId));
  } catch (error) {
    return adminError(error, request);
  }
}
