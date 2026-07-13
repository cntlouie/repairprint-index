import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { fitConfirmationIntakeStructuralSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    analyticsEvent: async (payload) => {
      const partSlug = typeof payload.partSlug === "string" ? payload.partSlug : "";
      const outcome = payload.outcome;
      if (
        outcome !== "fits_without_modification"
        && outcome !== "fits_after_modification"
        && outcome !== "does_not_fit"
        && outcome !== "print_failed"
        && outcome !== "unsure"
      ) return null;
      const { getPublishedFitmentAnalyticsFactsFromDatabase } = await import("@/db/catalog");
      const fitment = await getPublishedFitmentAnalyticsFactsFromDatabase(partSlug);
      return fitment
        ? { name: "fit_report_submitted", properties: { publicId: fitment.publicId, outcome } }
        : null;
    },
    kind: "fit_confirmation",
    returnPath: "/confirm-fit",
    structuralSchema: fitConfirmationIntakeStructuralSchema,
    turnstileAction: "fit_confirmation",
  });
}
