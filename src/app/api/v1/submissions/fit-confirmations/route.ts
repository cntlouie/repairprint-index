import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { fitConfirmationIntakeSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    kind: "fit_confirmation",
    returnPath: "/confirm-fit",
    schema: fitConfirmationIntakeSchema,
    turnstileAction: "fit_confirmation",
  });
}
