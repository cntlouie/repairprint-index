import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { missingPartRequestIntakeSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    kind: "missing_part",
    returnPath: "/request-part",
    schema: missingPartRequestIntakeSchema,
    turnstileAction: "missing_part",
  });
}
