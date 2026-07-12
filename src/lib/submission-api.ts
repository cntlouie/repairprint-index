import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import {
  canonicalSubmissionContent,
  canonicalSubmissionDedupeContent,
  privateSubmissionPayload,
  type AnonymousSubmissionKind,
} from "@/domain/submissions";
import {
  assertSubmissionOrigin,
  assertSubmissionProtectionConfigured,
  endpointSubmissionRateBuckets,
  globalSubmissionRateBuckets,
  readSubmissionPayload,
  SubmissionIntakeError,
  submissionContributorKey,
  submissionHmac,
  trustedSubmissionClientIp,
  verifyTurnstile,
} from "./submission-security";
import {
  productionSubmissionPersistence,
  resolveSubmissionRetentionPolicy,
  SubmissionIdempotencyConflictError,
  type AnonymousSubmissionPersistence,
} from "./submissions";

type SubmissionApiConfig = Readonly<{
  kind: AnonymousSubmissionKind;
  returnPath: string;
  schema: ZodType;
  turnstileAction: string;
}>;

export type SubmissionApiDependencies = Readonly<{
  createReceiptId: () => string;
  getPersistence: () => Promise<AnonymousSubmissionPersistence>;
  now: () => Date;
  resolveClientIp: (request: NextRequest) => string;
  verifyChallenge: typeof verifyTurnstile;
}>;

const defaultDependencies: SubmissionApiDependencies = {
  createReceiptId: randomUUID,
  getPersistence: productionSubmissionPersistence,
  now: () => new Date(),
  resolveClientIp: trustedSubmissionClientIp,
  verifyChallenge: verifyTurnstile,
};

const errorMessages: Record<string, string> = {
  CONSENT_REQUIRED: "Consent is required before this contribution can be queued.",
  HUMAN_VERIFICATION_FAILED: "Human verification failed. Please try again.",
  HUMAN_VERIFICATION_UNAVAILABLE: "Human verification is temporarily unavailable.",
  IDEMPOTENCY_KEY_REUSED: "This submission token was already used for different content.",
  INVALID_SUBMISSION: "Check the required fields and try again.",
  PAYLOAD_TOO_LARGE: "The submission is too large.",
  RATE_LIMITED: "Too many submissions. Please try again later.",
  SUBMISSION_ORIGIN_FORBIDDEN: "This submission origin is not allowed.",
  SUBMISSION_UNAVAILABLE: "The private contribution queue is temporarily unavailable.",
  UNSUPPORTED_MEDIA_TYPE: "This submission format is not supported.",
};

const privateResponseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

export async function handleAnonymousSubmission(
  request: NextRequest,
  config: SubmissionApiConfig,
  dependencies: SubmissionApiDependencies = defaultDependencies,
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;

  try {
    assertSubmissionOrigin(request);
    assertSubmissionProtectionConfigured();
    const clientIp = dependencies.resolveClientIp(request);
    const now = dependencies.now();
    resolveSubmissionRetentionPolicy(now, false);
    const persistence = await dependencies.getPersistence();
    const globalRateResult = await persistence.consumeRateLimits(globalSubmissionRateBuckets(clientIp, now), now);
    if (!globalRateResult.allowed) {
      throw new SubmissionIntakeError("RATE_LIMITED", 429, globalRateResult.retryAfterSeconds);
    }

    const rawPayload = await readSubmissionPayload(request);
    if (typeof rawPayload.website === "string" && rawPayload.website.trim()) {
      return acceptedSubmissionResponse(request, config.returnPath, dependencies.createReceiptId());
    }

    const parsed = config.schema.safeParse(rawPayload);
    if (!parsed.success) throw schemaFailure(parsed.error.issues);

    const intake = parsed.data as Record<string, unknown> & {
      challengeToken: string;
      email?: string;
      idempotencyKey: string;
    };
    const contributorKey = submissionContributorKey(clientIp, intake.email);
    const endpointRateResult = await persistence.consumeRateLimits(
      endpointSubmissionRateBuckets(config.kind, contributorKey, now),
      now,
    );
    if (!endpointRateResult.allowed) {
      throw new SubmissionIntakeError("RATE_LIMITED", 429, endpointRateResult.retryAfterSeconds);
    }
    await dependencies.verifyChallenge({
      action: config.turnstileAction,
      clientIp,
      token: intake.challengeToken,
    });

    const payload = privateSubmissionPayload(intake);
    const retention = resolveSubmissionRetentionPolicy(now, Boolean(intake.email));
    const persisted = await persistence.persist({
      challengeVerifiedAt: now,
      contactEmail: intake.email || undefined,
      contactRetentionExpiresAt: retention.contactRetentionExpiresAt,
      consentedAt: now,
      contentFingerprint: submissionHmac(
        "content-fingerprint",
        canonicalSubmissionDedupeContent(config.kind, payload),
      ),
      contributorKey,
      idempotencyKeyHash: submissionHmac(
        "idempotency-key",
        `${config.kind}\0${intake.idempotencyKey}`,
      ),
      kind: config.kind,
      payload,
      retentionExpiresAt: retention.retentionExpiresAt,
      retentionPolicyVersion: retention.retentionPolicyVersion,
      requestFingerprint: submissionHmac(
        "request-fingerprint",
        canonicalSubmissionContent(config.kind, {
          contactEmail: intake.email || null,
          contributorKey,
          payload,
        }),
      ),
    });

    return acceptedSubmissionResponse(request, config.returnPath, persisted.receiptId);
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.status >= 500) {
      console.error({
        code: "ANONYMOUS_SUBMISSION_FAILURE",
        failureCode: failure.code,
        kind: config.kind,
        requestId,
      });
    }
    return failedSubmissionResponse(request, config.returnPath, requestId, failure);
  }
}

function schemaFailure(issues: readonly { path: PropertyKey[] }[]): SubmissionIntakeError {
  const fields = new Set(issues.map((issue) => String(issue.path[0] ?? "")));
  if (fields.has("privacyConsent") || fields.has("contributionConsent") || fields.has("emailFollowUpConsent")) {
    return new SubmissionIntakeError("CONSENT_REQUIRED", 400);
  }
  if (fields.has("challengeToken")) return new SubmissionIntakeError("HUMAN_VERIFICATION_FAILED", 400);
  return new SubmissionIntakeError("INVALID_SUBMISSION", 400);
}

function normalizeFailure(error: unknown): SubmissionIntakeError {
  if (error instanceof SubmissionIntakeError) return error;
  if (error instanceof SubmissionIdempotencyConflictError) {
    return new SubmissionIntakeError("IDEMPOTENCY_KEY_REUSED", 409);
  }
  return new SubmissionIntakeError("SUBMISSION_UNAVAILABLE", 503);
}

function acceptedSubmissionResponse(request: NextRequest, returnPath: string, receiptId: string): NextResponse {
  if (acceptsHtml(request)) {
    const destination = new URL(returnPath, request.url);
    destination.searchParams.set("submitted", "1");
    return NextResponse.redirect(destination, { headers: privateResponseHeaders, status: 303 });
  }
  return NextResponse.json(
    { id: receiptId, status: "pending" },
    { headers: privateResponseHeaders, status: 202 },
  );
}

function failedSubmissionResponse(
  request: NextRequest,
  returnPath: string,
  requestId: string,
  failure: SubmissionIntakeError,
): NextResponse {
  const headers = new Headers(privateResponseHeaders);
  if (failure.retryAfterSeconds) headers.set("retry-after", String(failure.retryAfterSeconds));
  const message = errorMessages[failure.code] ?? errorMessages.SUBMISSION_UNAVAILABLE;

  if (acceptsHtml(request)) {
    headers.set("content-type", "text/html; charset=utf-8");
    const body = `<!doctype html><html lang="en"><meta name="robots" content="noindex,nofollow"><title>Contribution not queued</title><body><main><h1>Contribution not queued</h1><p>${message}</p><p>Reference: ${requestId}</p><p><a href="${returnPath}">Return to the form</a></p></main></body></html>`;
    return new NextResponse(body, { headers, status: failure.status });
  }

  return NextResponse.json(
    { error: { code: failure.code, message, requestId } },
    { headers, status: failure.status },
  );
}

function acceptsHtml(request: NextRequest): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}
