import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { PRIVATE_MEDIA_LIMITS, signMediaCapability, verifyMediaCapability, type MediaCapabilityClaims } from "@/domain/private-media";
import type { PrivateMediaConfig } from "./private-media-config";

export const privateMediaHeaders = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export function issueMediaCapability(publicId: string, operation: MediaCapabilityClaims["operation"], config: PrivateMediaConfig, now = new Date(), nonce = randomBytes(24).toString("base64url")): Readonly<{ expiresAt: Date; nonce: string; token: string }> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + PRIVATE_MEDIA_LIMITS.capabilitySeconds) * 1000);
  return Object.freeze({ expiresAt, nonce, token: signMediaCapability({ issuedAt, expiresAt: issuedAt + PRIVATE_MEDIA_LIMITS.capabilitySeconds, mediaPublicId: publicId, nonce, operation }, config.capabilitySecret) });
}

export function requireMediaCapability(request: NextRequest, publicId: string, operation: MediaCapabilityClaims["operation"], config: PrivateMediaConfig): MediaCapabilityClaims {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) throw new Error("MEDIA_CAPABILITY_REQUIRED");
  return verifyMediaCapability(value.slice(7), { mediaPublicId: publicId, operation }, config.capabilitySecret, new Date());
}

export function mediaJson(value: unknown, status = 200): NextResponse { return NextResponse.json(value, { status, headers: privateMediaHeaders }); }

export async function readBoundedMediaBody(request: NextRequest, expectedBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes || expectedBytes < 1
    || expectedBytes > PRIVATE_MEDIA_LIMITS.maxBytes || !request.body) throw new Error("MEDIA_SIZE_INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes || total > PRIVATE_MEDIA_LIMITS.maxBytes) {
        await reader.cancel("MEDIA_SIZE_INVALID");
        throw new Error("MEDIA_SIZE_INVALID");
      }
      chunks.push(Uint8Array.from(value));
    }
  } finally { reader.releaseLock(); }
  if (total !== expectedBytes) throw new Error("MEDIA_SIZE_INVALID");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function mediaError(error: unknown): NextResponse {
  const raw = error instanceof Error ? error.message : "MEDIA_INTERNAL_ERROR";
  const allowed = new Set(["MEDIA_CONSENT_REQUIRED", "MEDIA_POLICY_VERSION_REQUIRED", "MEDIA_INTAKE_NOT_FOUND", "MEDIA_PURPOSE_ALREADY_USED", "MEDIA_SIZE_INVALID", "MEDIA_TYPE_MISMATCH", "MEDIA_BYTES_UNSUPPORTED", "MEDIA_CONTAINER_INVALID", "MEDIA_DECODE_FAILED", "MEDIA_DIMENSIONS_INVALID", "MEDIA_PROCESSING_FAILED", "MEDIA_PROCESSING_LEASE_LOST", "MEDIA_CLEANUP_IN_PROGRESS", "MEDIA_UPLOAD_NOT_AVAILABLE", "MEDIA_FINALIZE_NOT_AVAILABLE", "MEDIA_CAPABILITY_REQUIRED", "MEDIA_CAPABILITY_INVALID", "MEDIA_CAPABILITY_SCOPE_INVALID", "MEDIA_CAPABILITY_EXPIRED", "MEDIA_UNAVAILABLE"]);
  const code = allowed.has(raw) ? raw : "MEDIA_UNAVAILABLE";
  console.error("Private media operation failed.", {
    code: "PRIVATE_MEDIA_OPERATION_FAILED",
    databaseCode: sanitizedDatabaseCode(error),
    databaseFailureClass: sanitizedDatabaseFailureClass(error),
    failureCode: code,
    failureKind: error instanceof Error ? error.name : "NonErrorThrown",
    internalCode: /^[A-Z][A-Z0-9_]{2,80}$/.test(raw) ? raw : "INTERNAL_OPERATION_FAILED",
  });
  const status = code === "MEDIA_INTAKE_NOT_FOUND" ? 404 : code === "MEDIA_UNAVAILABLE" ? 503 : code.includes("CAPABILITY") ? 403 : 400;
  return mediaJson({ error: { code, requestId: `req_${randomUUID()}` } }, status);
}

function sanitizedDatabaseCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function sanitizedDatabaseFailureClass(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : "";
    if (message.includes("permission denied")) return "DATABASE_PERMISSION_DENIED";
    if (message.includes("violates check constraint")) return "DATABASE_CHECK_VIOLATION";
    if (message.includes("violates foreign key constraint")) return "DATABASE_FOREIGN_KEY_VIOLATION";
    if (message.includes("duplicate key value")) return "DATABASE_UNIQUE_VIOLATION";
    if (message.includes("does not exist")) return "DATABASE_SCHEMA_MISMATCH";
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
