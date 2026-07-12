import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { designSubmissionIntakeSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    kind: "design_submission",
    returnPath: "/submit-design",
    schema: designSubmissionIntakeSchema,
    turnstileAction: "design_submission",
  });
}
