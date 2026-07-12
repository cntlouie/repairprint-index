import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { missingPartRequestIntakeStructuralSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    kind: "missing_part",
    returnPath: "/request-part",
    structuralSchema: missingPartRequestIntakeStructuralSchema,
    turnstileAction: "missing_part",
  });
}
