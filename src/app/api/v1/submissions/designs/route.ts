import type { NextRequest } from "next/server";

import { classifyDesignSourcePlatform } from "@/domain/analytics";
import { handleAnonymousSubmission } from "@/lib/submission-api";
import { designSubmissionIntakeStructuralSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    analyticsEvent: (payload) => ({
      name: "design_submitted",
      properties: {
        sourcePlatform: classifyDesignSourcePlatform(typeof payload.sourceUrl === "string" ? payload.sourceUrl : ""),
      },
    }),
    kind: "design_submission",
    returnPath: "/submit-design",
    structuralSchema: designSubmissionIntakeStructuralSchema,
    turnstileAction: "design_submission",
  });
}
