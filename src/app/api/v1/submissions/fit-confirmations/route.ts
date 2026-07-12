import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { fitConfirmationIntakeStructuralSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    kind: "fit_confirmation",
    returnPath: "/confirm-fit",
    structuralSchema: fitConfirmationIntakeStructuralSchema,
    turnstileAction: "fit_confirmation",
  });
}
