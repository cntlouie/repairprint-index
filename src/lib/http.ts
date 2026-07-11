import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function requestPayload(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  }

  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export function submissionResponse(
  request: NextRequest,
  returnPath: string,
  result: { id: string; persisted: boolean },
) {
  const acceptsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (acceptsHtml) {
    const url = new URL(returnPath, request.url);
    url.searchParams.set("submitted", "1");
    url.searchParams.set("saved", result.persisted ? "1" : "0");
    return NextResponse.redirect(url, 303);
  }
  return NextResponse.json(result, { status: 202 });
}

export function invalidSubmissionResponse(request: NextRequest, returnPath: string) {
  const acceptsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (acceptsHtml) {
    const url = new URL(returnPath, request.url);
    url.searchParams.set("error", "invalid");
    return NextResponse.redirect(url, 303);
  }
  return NextResponse.json({ error: "INVALID_SUBMISSION" }, { status: 400 });
}
