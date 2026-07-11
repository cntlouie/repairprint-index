import type { NextRequest } from "next/server";
import { invalidSubmissionResponse, requestPayload, submissionResponse } from "@/lib/http";
import { missingPartRequestSchema } from "@/lib/submission-schemas";
import { saveSubmission } from "@/lib/submissions";

export async function POST(request: NextRequest) {
  const parsed = missingPartRequestSchema.safeParse(await requestPayload(request));
  if (!parsed.success) return invalidSubmissionResponse(request, "/request-part");
  if (parsed.data.website) return submissionResponse(request, "/request-part", { id: "accepted", persisted: false });
  const result = await saveSubmission("missing_part", parsed.data);
  return submissionResponse(request, "/request-part", result);
}
