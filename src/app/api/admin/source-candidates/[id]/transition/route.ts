import type { NextRequest } from "next/server";
import { z } from "zod";

import { adminError, adminJson, authorizeAdminRequest, parseAdminBody } from "@/lib/admin-api";
import { sanitizeSourceOperationError } from "@/lib/source-errors";

export const dynamic = "force-dynamic";

const stage = z.enum(["discovered", "fetched", "parsed", "normalized", "ambiguous", "safety_screened", "review_ready", "approved", "rejected"]);
const transitionSchema = z.object({ expectedStage: stage, nextStage: stage, reason: z.string().trim().min(8).max(500) });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await parseAdminBody(request, transitionSchema);
    const reviewDecision = body.nextStage === "approved" || body.nextStage === "rejected";
    const staff = await authorizeAdminRequest(request, reviewDecision ? "policy:manage" : "draft:write");
    const { id } = await context.params;
    const versionId = z.string().uuid().parse(id);
    const { transitionPrivateSourceCandidate } = await import("@/db/source-operations");
    await transitionPrivateSourceCandidate({
      versionId,
      expectedStage: body.expectedStage,
      nextStage: body.nextStage,
      actorId: staff.id,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`,
    });
    return adminJson({ candidateVersion: { id: versionId, stage: body.nextStage } });
  } catch (error) {
    return adminError(sanitizeSourceOperationError(error), request);
  }
}
