import { type NextRequest } from "next/server";
import { z } from "zod";

import { listPrivateReviewMedia } from "@/db/private-media-review";
import { adminError, adminJson, authorizeAdminRequest } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authorizeAdminRequest(request, "evidence:review");
    const submissionId = z.uuid().parse((await context.params).id);
    const intakeId = z.uuid().parse(request.nextUrl.searchParams.get("intakeId"));
    const requestId = request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`;
    const media = await listPrivateReviewMedia({ actorId: actor.id, intakeId, requestId, submissionId });
    return adminJson({ media });
  } catch (error) { return adminError(error, request); }
}
