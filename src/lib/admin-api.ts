import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";

import type { StaffAction, StaffIdentity } from "@/domain/authorization";
import { StaffAuthorizationError, requireStaffAuthorization } from "@/lib/staff-auth";

export async function authorizeAdminRequest(request: NextRequest, action: StaffAction): Promise<StaffIdentity> {
  return requireStaffAuthorization(request.headers.get("authorization"), action, {
    findStaffByAuthUserId: async (authUserId) => {
      const { findStaffByAuthUserId } = await import("@/db/staff");
      return findStaffByAuthUserId(authUserId);
    },
  });
}

export async function parseAdminBody<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  return schema.parse(await request.json());
}

export function adminJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export function adminError(error: unknown, request: NextRequest): NextResponse {
  const requestId = request.headers.get("x-request-id") ?? `req_${crypto.randomUUID()}`;
  if (error instanceof StaffAuthorizationError) {
    return adminJson({ error: { code: error.code, message: authMessage(error.code), requestId } }, error.status);
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return adminJson({ error: { code: "INPUT_INVALID", message: issue?.message ?? "Input is invalid.", field: issue?.path.join("."), requestId } }, 400);
  }
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  const details = error && typeof error === "object" && "details" in error ? error.details : undefined;
  const status = code.endsWith("_NOT_FOUND") ? 404 : code === "PUBLICATION_BLOCKED" || code.includes("FORBIDDEN") || code.includes("MISMATCH") ? 409 : 400;
  return adminJson({ error: { code, message: editorialMessage(code), details, requestId } }, status);
}

function authMessage(code: string): string {
  if (code === "MFA_REQUIRED") return "Complete authenticator verification before this action.";
  if (code === "AUTH_REQUIRED") return "Sign in with an invited staff account.";
  return "Staff authorization failed.";
}

function editorialMessage(code: string): string {
  const messages: Record<string, string> = {
    PUBLICATION_BLOCKED: "Publication checks found one or more blockers.",
    SELF_REVIEW_FORBIDDEN: "A different reviewer must decide this prepared case.",
    EXACT_TARGET_MISMATCH: "The selected exact model does not match the submitted model label.",
    DUPLICATE_EXTERNAL_ITEM: "This landing page is already recorded and must be resolved as a duplicate.",
    SOURCE_POLICY_MISSING: "The source platform has no reviewed policy record.",
    REDIRECT_INVALID: "Choose a different internal replacement path.",
  };
  return messages[code] ?? code.replaceAll("_", " ").toLocaleLowerCase("en");
}
