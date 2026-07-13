import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import type { ZodType } from "zod";

import type { AnalyticsEvent } from "@/domain/analytics";
import {
  canonicalSubmissionDedupeContent,
  canonicalSubmissionRequestFingerprint,
  privateSubmissionPayload,
  semanticSubmissionPayload,
  type AnonymousSubmissionKind,
} from "@/domain/submissions";
import {
  CONTACT_CONSENT_VERSION,
  CONTRIBUTOR_TERMS_VERSION,
  PRIVACY_NOTICE_VERSION,
} from "./submission-constants";
import {
  assertSubmissionOrigin,
  assertSubmissionProtectionConfigured,
  endpointSubmissionRateBuckets,
  globalSubmissionRateBuckets,
  readSubmissionPayload,
  SubmissionIntakeError,
  submissionContactDigest,
  submissionHmac,
  submissionIdempotencyActorKey,
  submissionSemanticContributorKey,
  SUBMISSION_HMAC_ALGORITHM_VERSION,
  trustedSubmissionClientIp,
  verifyTurnstile,
} from "./submission-security";
import { bestEffortRecordAnalyticsEvent, resolveAnalyticsConfiguration } from "./analytics";
import {
  hasRequiredNewSubmissionConsent,
  type AnonymousSubmissionIntake,
} from "./submission-schemas";
import {
  productionSubmissionPersistence,
  resolveSubmissionRetentionPolicy,
  SubmissionIdempotencyConflictError,
  type AnonymousSubmissionPersistence,
} from "./submissions";

type SubmissionApiConfig = Readonly<{
  analyticsEvent?: (payload: Readonly<Record<string, unknown>>) => AnalyticsEvent | null | Promise<AnalyticsEvent | null>;
  kind: AnonymousSubmissionKind;
  returnPath: string;
  structuralSchema: ZodType;
  turnstileAction: string;
}>;

export type SubmissionApiDependencies = Readonly<{
  createReceiptId: () => string;
  getPersistence: () => Promise<AnonymousSubmissionPersistence>;
  now: () => Date;
  resolveClientIp: (request: NextRequest) => string;
  analyticsEnabled?: () => boolean;
  recordAnalytics?: (event: AnalyticsEvent) => Promise<unknown>;
  scheduleAfterResponse?: (task: () => Promise<void>) => void;
  verifyChallenge: typeof verifyTurnstile;
}>;

const defaultDependencies: SubmissionApiDependencies = {
  createReceiptId: randomUUID,
  getPersistence: productionSubmissionPersistence,
  now: () => new Date(),
  analyticsEnabled: () => resolveAnalyticsConfiguration(process.env).enabled,
  recordAnalytics: bestEffortRecordAnalyticsEvent,
  resolveClientIp: trustedSubmissionClientIp,
  scheduleAfterResponse: after,
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
    const now = dependencies.now();
    resolveSubmissionRetentionPolicy(now, false);
    const persistence = await dependencies.getPersistence();
    await persistence.verifyHmacKeyPin();
    const rawPayload = await readSubmissionPayload(request);
    if (typeof rawPayload.website === "string" && rawPayload.website.trim()) {
      return acceptedSubmissionResponse(request, config.returnPath, dependencies.createReceiptId());
    }

    const clientIp = dependencies.resolveClientIp(request);
    const globalRateResult = await persistence.consumeRateLimits(globalSubmissionRateBuckets(clientIp, now), now);
    if (!globalRateResult.allowed) {
      throw new SubmissionIntakeError("RATE_LIMITED", 429, globalRateResult.retryAfterSeconds);
    }

    const parsed = config.structuralSchema.safeParse(rawPayload);
    if (!parsed.success) throw schemaFailure(parsed.error.issues);

    const intake = parsed.data as AnonymousSubmissionIntake;
    const contactEmail = intake.email || undefined;
    const contactDigest = submissionContactDigest(contactEmail);
    const contributorKey = submissionSemanticContributorKey(clientIp, contactEmail);
    const idempotencyActorKey = submissionIdempotencyActorKey(clientIp);
    const idempotencyKeyHash = submissionHmac("idempotency-key", intake.idempotencyKey);
    const payload = privateSubmissionPayload(intake);
    const retention = resolveSubmissionRetentionPolicy(now, Boolean(contactEmail));
    const requestFingerprint = submissionHmac(
      "request-fingerprint",
      canonicalSubmissionRequestFingerprint({
        contact: {
          digest: contactDigest ?? null,
          present: Boolean(contactEmail),
        },
        decisions: {
          contributionConsent: intake.contributionConsent,
          emailFollowUpConsent: intake.emailFollowUpConsent,
          privacyConsent: intake.privacyConsent,
        },
        kind: config.kind,
        payload,
        versions: {
          contactConsent: CONTACT_CONSENT_VERSION,
          contributorTerms: CONTRIBUTOR_TERMS_VERSION,
          privacyNotice: PRIVACY_NOTICE_VERSION,
          retentionPolicy: retention.retentionPolicyVersion,
        },
      }),
    );
    const idempotencyLookup = Object.freeze({
      idempotencyActorKey,
      idempotencyKeyHash,
      kind: config.kind,
    });
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

    const existing = await persistence.findIdempotency(idempotencyLookup);
    if (existing) {
      assertMatchingIdempotencyFingerprint(existing.requestFingerprint, requestFingerprint);
      return acceptedSubmissionResponse(request, config.returnPath, existing.receiptId);
    }

    if (!hasRequiredNewSubmissionConsent(intake)) {
      throw new SubmissionIntakeError("CONSENT_REQUIRED", 400);
    }

    let persisted;
    try {
      persisted = await persistence.persist({
        challengeVerifiedAt: now,
        contactConsentVersion: CONTACT_CONSENT_VERSION,
        contactDigest,
        contactEmail,
        contactPresent: Boolean(contactEmail),
        contactRetentionExpiresAt: retention.contactRetentionExpiresAt,
        consentedAt: now,
        contributionConsent: intake.contributionConsent,
        contentFingerprint: submissionHmac(
          "content-fingerprint",
          canonicalSubmissionDedupeContent(config.kind, payload),
        ),
        contributorTermsVersion: CONTRIBUTOR_TERMS_VERSION,
        contributorKey,
        emailFollowUpConsent: intake.emailFollowUpConsent,
        hmacVersion: SUBMISSION_HMAC_ALGORITHM_VERSION,
        idempotencyActorKey,
        idempotencyKeyHash,
        kind: config.kind,
        payload,
        privacyConsent: intake.privacyConsent,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        retentionExpiresAt: retention.retentionExpiresAt,
        retentionPolicyVersion: retention.retentionPolicyVersion,
        requestFingerprint,
        semanticPayload: semanticSubmissionPayload(config.kind, payload),
      });
    } catch (error) {
      if (!(error instanceof SubmissionIdempotencyConflictError)) throw error;
      const raced = await persistence.findIdempotency(idempotencyLookup);
      if (!raced) throw error;
      assertMatchingIdempotencyFingerprint(raced.requestFingerprint, requestFingerprint);
      return acceptedSubmissionResponse(request, config.returnPath, raced.receiptId);
    }

    scheduleNewSubmissionAnalytics(config, payload, dependencies);
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

function scheduleNewSubmissionAnalytics(
  config: SubmissionApiConfig,
  payload: Readonly<Record<string, unknown>>,
  dependencies: SubmissionApiDependencies,
): void {
  if (!config.analyticsEvent) return;

  try {
    if (!(dependencies.analyticsEnabled ?? defaultDependencies.analyticsEnabled)?.()) return;
    const scheduleAfterResponse = dependencies.scheduleAfterResponse ?? defaultDependencies.scheduleAfterResponse;
    if (!scheduleAfterResponse) throw new Error("Submission analytics response scheduler is unavailable.");
    scheduleAfterResponse(() => recordNewSubmissionAnalytics(config, payload, dependencies));
  } catch {
    reportDroppedSubmissionAnalytics(config.kind);
  }
}

async function recordNewSubmissionAnalytics(
  config: SubmissionApiConfig,
  payload: Readonly<Record<string, unknown>>,
  dependencies: SubmissionApiDependencies,
): Promise<void> {
  try {
    const event = await config.analyticsEvent?.(payload);
    if (event) await (dependencies.recordAnalytics ?? defaultDependencies.recordAnalytics)?.(event);
  } catch {
    // Completion analytics is optional and must never expose payloads or affect the accepted submission.
    reportDroppedSubmissionAnalytics(config.kind);
  }
}

function reportDroppedSubmissionAnalytics(kind: AnonymousSubmissionKind): void {
  console.error({ code: "SUBMISSION_ANALYTICS_DROPPED", kind });
}

function assertMatchingIdempotencyFingerprint(existing: string, supplied: string): void {
  if (existing !== supplied) throw new SubmissionIdempotencyConflictError();
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
    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Contribution not queued</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #171717; background: #fff; }
  main { box-sizing: border-box; max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem; }
  [role="alert"]:focus { outline: 3px solid #155eef; outline-offset: 4px; }
</style>
</head>
<body>
<main id="main-content">
  <section id="submission-error" role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby="submission-error-title" aria-describedby="submission-error-message submission-error-reference" tabindex="-1">
    <h1 id="submission-error-title">Contribution not queued</h1>
    <p id="submission-error-message">${message}</p>
    <p id="submission-error-reference">Reference: ${requestId}</p>
  </section>
  <p><a href="${returnPath}">Return to the form</a></p>
</main>
<script>document.getElementById("submission-error")?.focus();</script>
</body>
</html>`;
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
