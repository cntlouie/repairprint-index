import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { TURNSTILE_DEMO_TOKEN } from "./submission-constants";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export { TURNSTILE_DEMO_TOKEN } from "./submission-constants";
export const MAX_SUBMISSION_BYTES = 16 * 1024;

export type SubmissionFailureCode =
  | "CONSENT_REQUIRED"
  | "HUMAN_VERIFICATION_FAILED"
  | "HUMAN_VERIFICATION_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_SUBMISSION"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SUBMISSION_ORIGIN_FORBIDDEN"
  | "SUBMISSION_UNAVAILABLE"
  | "UNSUPPORTED_MEDIA_TYPE";

export class SubmissionIntakeError extends Error {
  readonly code: SubmissionFailureCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: SubmissionFailureCode, status: number, retryAfterSeconds?: number) {
    super(code);
    this.name = "SubmissionIntakeError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type SubmissionRateBucket = Readonly<{
  expiresAt: Date;
  limit: number;
  scope: string;
  subjectHash: string;
  windowSeconds: number;
  windowStartedAt: Date;
}>;

const ratePolicies = [
  { scope: "anonymous-submission:10m", windowSeconds: 10 * 60, limit: 5 },
  { scope: "anonymous-submission:24h", windowSeconds: 24 * 60 * 60, limit: 20 },
] as const;

export function trustedSubmissionClientIp(request: NextRequest): string {
  if (process.env.VERCEL !== "1") {
    if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE === "false") {
      throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
    }
    return "127.0.0.1";
  }

  const value = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  if (!value || value.includes(",") || isIP(value) === 0) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }
  return value;
}

export function assertSubmissionOrigin(request: NextRequest): void {
  const supplied = request.headers.get("origin");
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  const allowedOrigins = new Set<string>();

  if (configured) {
    try {
      allowedOrigins.add(new URL(configured).origin);
    } catch {
      throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
    }
  }
  if (process.env.DEMO_MODE !== "false") allowedOrigins.add(request.nextUrl.origin);

  if (!supplied || supplied === "null" || !allowedOrigins.has(supplied)) {
    throw new SubmissionIntakeError("SUBMISSION_ORIGIN_FORBIDDEN", 403);
  }
}

export function assertSubmissionProtectionConfigured(): void {
  if (process.env.DEMO_MODE !== "false") return;
  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY) {
    throw new SubmissionIntakeError("HUMAN_VERIFICATION_UNAVAILABLE", 503);
  }
}

export async function readSubmissionPayload(request: NextRequest): Promise<Record<string, unknown>> {
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new SubmissionIntakeError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new SubmissionIntakeError("INVALID_SUBMISSION", 400);
    }
    if (length > MAX_SUBMISSION_BYTES) {
      throw new SubmissionIntakeError("PAYLOAD_TOO_LARGE", 413);
    }
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
    throw new SubmissionIntakeError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  const bytes = await readBoundedBytes(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SubmissionIntakeError("INVALID_SUBMISSION", 400);
  }

  if (contentType === "application/json") return parseJsonRecord(text);
  return parseFormRecord(text);
}

async function readBoundedBytes(request: NextRequest): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SUBMISSION_BYTES) {
      await reader.cancel();
      throw new SubmissionIntakeError("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SubmissionIntakeError("INVALID_SUBMISSION", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubmissionIntakeError("INVALID_SUBMISSION", 400);
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>));
}

function parseFormRecord(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const record: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(record, key)) throw new SubmissionIntakeError("INVALID_SUBMISSION", 400);
    record[key] = value;
  }
  return record;
}

export function submissionHmac(purpose: string, value: string, secret = process.env.SUBMISSION_HMAC_SECRET): string {
  const resolvedSecret = secret ?? (process.env.DEMO_MODE !== "false" ? "repairprint-demo-only-hmac-secret-not-for-production" : undefined);
  if (!resolvedSecret || Buffer.byteLength(resolvedSecret, "utf8") < 32) {
    throw new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
  }
  return createHmac("sha256", resolvedSecret).update(`repairprint/${purpose}/v1\0${value}`).digest("hex");
}

export function submissionRateBuckets(clientIp: string, now = new Date()): readonly SubmissionRateBucket[] {
  return Object.freeze(ratePolicies.map((policy) => {
    const windowStartMilliseconds = Math.floor(now.getTime() / (policy.windowSeconds * 1000))
      * policy.windowSeconds
      * 1000;
    const windowStartedAt = new Date(windowStartMilliseconds);
    const expiresAt = new Date(windowStartMilliseconds + 48 * 60 * 60 * 1000);
    const subjectHash = submissionHmac(
      "rate-subject",
      `${policy.scope}\0${windowStartedAt.toISOString()}\0${clientIp}`,
    );
    return Object.freeze({ ...policy, expiresAt, subjectHash, windowStartedAt });
  }));
}

type TurnstileVerificationInput = Readonly<{
  action: string;
  clientIp: string;
  token: string;
}>;

type TurnstileVerificationOptions = Readonly<{
  fetchImplementation?: typeof fetch;
  hostname?: string;
  secret?: string;
  timeoutMilliseconds?: number;
}>;

export async function verifyTurnstile(
  input: TurnstileVerificationInput,
  options: TurnstileVerificationOptions = {},
): Promise<void> {
  if (process.env.DEMO_MODE !== "false" && input.token === TURNSTILE_DEMO_TOKEN) return;

  const secret = options.secret ?? process.env.TURNSTILE_SECRET_KEY;
  const hostname = options.hostname ?? configuredSiteHostname();
  if (!secret || !hostname) throw new SubmissionIntakeError("HUMAN_VERIFICATION_UNAVAILABLE", 503);

  const body = new URLSearchParams({
    idempotency_key: randomUUID(),
    remoteip: input.clientIp,
    response: input.token,
    secret,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 4000);

  try {
    const response = await (options.fetchImplementation ?? fetch)(TURNSTILE_SITEVERIFY_URL, {
      body,
      cache: "no-store",
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new SubmissionIntakeError("HUMAN_VERIFICATION_UNAVAILABLE", 503);

    const result: unknown = await response.json();
    if (!isTurnstileSuccess(result, input.action, hostname)) {
      throw new SubmissionIntakeError("HUMAN_VERIFICATION_FAILED", 400);
    }
  } catch (error) {
    if (error instanceof SubmissionIntakeError) throw error;
    throw new SubmissionIntakeError("HUMAN_VERIFICATION_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function configuredSiteHostname(): string | undefined {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configured) return undefined;
  try {
    return new URL(configured).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isTurnstileSuccess(value: unknown, action: string, hostname: string): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.success === true
    && result.action === action
    && typeof result.hostname === "string"
    && result.hostname.toLowerCase() === hostname;
}
