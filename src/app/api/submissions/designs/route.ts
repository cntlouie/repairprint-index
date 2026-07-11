import type { NextRequest } from "next/server";
import { invalidSubmissionResponse, requestPayload, submissionResponse } from "@/lib/http";
import { designSubmissionSchema } from "@/lib/submission-schemas";
import { saveSubmission } from "@/lib/submissions";

export async function POST(request: NextRequest) {
  const parsed = designSubmissionSchema.safeParse(await requestPayload(request));
  if (!parsed.success) return invalidSubmissionResponse(request, "/submit-design");
  if (parsed.data.website) return submissionResponse(request, "/submit-design", { id: "accepted", persisted: false });
  const result = await saveSubmission("design_submission", parsed.data);
  return submissionResponse(request, "/submit-design", result);
}
