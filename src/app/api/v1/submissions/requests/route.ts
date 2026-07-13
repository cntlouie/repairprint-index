import type { NextRequest } from "next/server";

import { handleAnonymousSubmission } from "@/lib/submission-api";
import { missingPartRequestIntakeStructuralSchema } from "@/lib/submission-schemas";

export async function POST(request: NextRequest) {
  return handleAnonymousSubmission(request, {
    analyticsEvent: async (payload) => {
      const brokenPart = typeof payload.brokenPart === "string" ? payload.brokenPart : "";
      const { resolvePublishedCategoryForAnalyticsFromDatabase } = await import("@/db/catalog");
      const category = await resolvePublishedCategoryForAnalyticsFromDatabase(brokenPart);
      return category
        ? { name: "missing_part_submitted", properties: { categoryMatch: "matched", category } }
        : { name: "missing_part_submitted", properties: { categoryMatch: "unmatched" } };
    },
    kind: "missing_part",
    returnPath: "/request-part",
    structuralSchema: missingPartRequestIntakeStructuralSchema,
    turnstileAction: "missing_part",
  });
}
