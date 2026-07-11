import type { NextRequest } from "next/server";
import { invalidSubmissionResponse, requestPayload, submissionResponse } from "@/lib/http";
import { fitConfirmationSchema } from "@/lib/submission-schemas";
import { saveSubmission } from "@/lib/submissions";

export async function POST(request: NextRequest) {
  const parsed = fitConfirmationSchema.safeParse(await requestPayload(request));
  if (!parsed.success) return invalidSubmissionResponse(request, "/confirm-fit");
  if (parsed.data.website) return submissionResponse(request, "/confirm-fit", { id: "accepted", persisted: false });
  const result = await saveSubmission("fit_confirmation", parsed.data);
  return submissionResponse(request, "/confirm-fit", result);
}
