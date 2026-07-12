import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postDesign } from "@/app/api/v1/submissions/designs/route";
import { POST as postFitConfirmation } from "@/app/api/v1/submissions/fit-confirmations/route";
import { POST as postRequest } from "@/app/api/v1/submissions/requests/route";
import { handleAnonymousSubmission, type SubmissionApiDependencies } from "@/lib/submission-api";
import {
  designSubmissionIntakeSchema,
  fitConfirmationIntakeSchema,
  missingPartRequestIntakeSchema,
} from "@/lib/submission-schemas";
import { endpointSubmissionRateBuckets, globalSubmissionRateBuckets } from "@/lib/submission-security";
import { SubmissionIdempotencyConflictError, type AnonymousSubmissionPersistence } from "@/lib/submissions";

const originalEnvironment = { ...process.env };
const now = new Date("2026-07-12T12:00:00.000Z");
const receiptId = "f2504b77-eaf7-47b5-ae67-9fe251bed226";

describe("anonymous submission API", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_URL: "https://repairprint.example",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "public-site-key-fixture",
      SUBMISSION_HMAC_SECRET: "submission-test-secret-that-is-at-least-32-bytes",
      SUBMISSION_RETENTION_POLICY_VERSION: "wp08-test-retention-v1",
      SUBMISSION_RETENTION_DAYS: "90",
      SUBMISSION_CONTACT_RETENTION_DAYS: "30",
      TURNSTILE_SECRET_KEY: "server-turnstile-secret-fixture",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it.each(endpointCases())("queues a private $kind payload with an opaque receipt", async ({ config, fixture }) => {
    const harness = createHarness();
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ id: receiptId, status: "pending" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(harness.persist).toHaveBeenCalledOnce();
    expect(harness.persist.mock.calls[0]?.[0]).toMatchObject({
      challengeVerifiedAt: now,
      contactRetentionExpiresAt: new Date("2026-08-11T12:00:00.000Z"),
      consentedAt: now,
      kind: config.kind,
      retentionExpiresAt: new Date("2026-10-10T12:00:00.000Z"),
      retentionPolicyVersion: "wp08-test-retention-v1",
    });
    expect(JSON.stringify(harness.persist.mock.calls[0]?.[0].payload)).not.toMatch(
      /email|challenge|consent|website|idempotency/i,
    );
  });

  it.each([
    { endpoint: postRequest, fixtureIndex: 0, path: "requests" },
    { endpoint: postFitConfirmation, fixtureIndex: 1, path: "fit-confirmations" },
    { endpoint: postDesign, fixtureIndex: 2, path: "designs" },
  ])("wires the canonical /api/v1/submissions/$path route through the protected flow", async ({ endpoint, fixtureIndex, path }) => {
    process.env.DEMO_MODE = "true";
    const fixture = {
      ...endpointCases()[fixtureIndex]!.fixture,
      challengeToken: "XXXX.DUMMY.TOKEN.XXXX",
    };
    const request = new NextRequest(`https://repairprint.example/api/v1/submissions/${path}`, {
      body: JSON.stringify(fixture),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://repairprint.example",
      },
      method: "POST",
    });
    const response = await endpoint(request);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "pending" });
  });

  it("makes new, duplicate and honeypot receipts indistinguishable", async () => {
    const normal = createHarness();
    const duplicate = createHarness({
      persistResult: { duplicate: true, id: "existing-private-id", receiptId },
    });
    const honeypot = createHarness();
    const config = endpointCases()[0]!.config;
    const fixture = endpointCases()[0]!.fixture;

    const responses = await Promise.all([
      handleAnonymousSubmission(jsonRequest(fixture), config, normal.dependencies),
      handleAnonymousSubmission(jsonRequest(fixture), config, duplicate.dependencies),
      handleAnonymousSubmission(jsonRequest({ ...fixture, website: "https://spam.invalid" }), config, honeypot.dependencies),
    ]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { id: receiptId, status: "pending" },
      { id: receiptId, status: "pending" },
      { id: receiptId, status: "pending" },
    ]);
    expect(honeypot.verifyChallenge).not.toHaveBeenCalled();
    expect(honeypot.persist).not.toHaveBeenCalled();
    expect(honeypot.consumeRateLimits).toHaveBeenCalledOnce();
  });

  it("returns the database-stable receipt for an idempotent retry rather than generating a new one", async () => {
    const generatedReceipts = ["generated-honeypot-a", "generated-honeypot-b"];
    const harness = createHarness({
      createReceiptId: () => generatedReceipts.shift() ?? "unexpected",
      persistResult: { duplicate: true, id: "private-row-id", receiptId },
    });
    const { config, fixture } = endpointCases()[0]!;
    const first = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    const second = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(await first.json()).toEqual({ id: receiptId, status: "pending" });
    expect(await second.json()).toEqual({ id: receiptId, status: "pending" });
    expect(generatedReceipts).toHaveLength(2);
  });

  it("scopes idempotency and request fingerprints to the canonical contributor", async () => {
    const left = createHarness({ clientIp: "203.0.113.9" });
    const right = createHarness({ clientIp: "203.0.113.10" });
    const { config, fixture } = endpointCases()[0]!;
    const noContact = { ...fixture, email: "", emailFollowUpConsent: false, modelNumber: "DV100" };
    await handleAnonymousSubmission(jsonRequest(noContact), config, left.dependencies);
    await handleAnonymousSubmission(jsonRequest(noContact), config, right.dependencies);
    const leftInput = left.persist.mock.calls[0]?.[0];
    const rightInput = right.persist.mock.calls[0]?.[0];
    expect(leftInput?.payload.modelNumber).toBe("DV100");
    expect(leftInput?.contributorKey).not.toBe(rightInput?.contributorKey);
    expect(leftInput?.idempotencyKeyHash).toBe(rightInput?.idempotencyKeyHash);
    expect(leftInput?.requestFingerprint).not.toBe(rightInput?.requestFingerprint);
  });

  it("preserves real HTTP status for an HTML error and uses a fixed safe return link", async () => {
    const harness = createHarness({ rateResult: { allowed: false, retryAfterSeconds: 91 } });
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(
      jsonRequest(fixture, "text/html"),
      config,
      harness.dependencies,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("91");
    const html = await response.text();
    expect(html).toContain('href="/request-part"');
    expect(html).not.toContain(JSON.stringify(fixture));
  });

  it("redirects a successful browser form only to its fixed return path", async () => {
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture, "text/html"), config, harness.dependencies);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://repairprint.example/request-part?submitted=1");
  });

  it("accepts the real URL-encoded browser form contract", async () => {
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const form = new URLSearchParams();
    for (const [field, value] of Object.entries(fixture)) {
      form.set(field, value === true ? "on" : String(value));
    }
    const request = new NextRequest("https://repairprint.example/api/v1/submissions/requests", {
      body: form,
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://repairprint.example",
      },
      method: "POST",
    });
    const response = await handleAnonymousSubmission(request, config, harness.dependencies);
    expect(response.status).toBe(303);
    expect(harness.persist).toHaveBeenCalledOnce();
  });

  it("rejects missing consent before challenge verification or persistence", async () => {
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(
      jsonRequest({ ...fixture, privacyConsent: false }),
      config,
      harness.dependencies,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CONSENT_REQUIRED" } });
    expect(harness.verifyChallenge).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("fails with 503 before schema validation when production human verification is not configured", async () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(
      jsonRequest({ ...fixture, challengeToken: "" }),
      config,
      harness.dependencies,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "HUMAN_VERIFICATION_UNAVAILABLE" },
    });
    expect(harness.verifyChallenge).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it.each([
    "SUBMISSION_RETENTION_POLICY_VERSION",
    "SUBMISSION_RETENTION_DAYS",
    "SUBMISSION_CONTACT_RETENTION_DAYS",
  ] as const)("fails closed before database work when %s is absent", async (variable) => {
    delete process.env[variable];
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SUBMISSION_UNAVAILABLE" } });
    expect(harness.consumeRateLimits).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it.each([
    { contactDays: "91", days: "90", version: "valid-v1" },
    { contactDays: "30", days: "0", version: "valid-v1" },
    { contactDays: "30", days: "90", version: "invalid version" },
  ])("fails closed for invalid server retention policy %#", async ({ contactDays, days, version }) => {
    process.env.SUBMISSION_CONTACT_RETENTION_DAYS = contactDays;
    process.env.SUBMISSION_RETENTION_DAYS = days;
    process.env.SUBMISSION_RETENTION_POLICY_VERSION = version;
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(503);
    expect(harness.consumeRateLimits).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("stops before body parsing/challenge/persistence when the durable rate gate denies", async () => {
    const harness = createHarness({ rateResult: { allowed: false, retryAfterSeconds: 60 } });
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(429);
    expect(harness.verifyChallenge).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it.each(endpointCases())(
    "applies global network limits before $kind endpoint-contributor limits",
    async ({ config, fixture }) => {
      const harness = createHarness();
      const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
      expect(response.status).toBe(202);
      expect(harness.consumeRateLimits).toHaveBeenCalledTimes(2);

      const [globalCall, endpointCall] = harness.consumeRateLimits.mock.calls;
      expect(globalCall?.[0]).toEqual(globalSubmissionRateBuckets("203.0.113.9", now));
      const contributorKey = harness.persist.mock.calls[0]?.[0].contributorKey;
      expect(contributorKey).toMatch(/^[0-9a-f]{64}$/);
      expect(endpointCall?.[0]).toEqual(endpointSubmissionRateBuckets(config.kind, contributorKey!, now));
      expect(JSON.stringify(harness.consumeRateLimits.mock.calls)).not.toMatch(/203\.0\.113\.9|person@example/i);
    },
  );

  it("fails closed at the endpoint-contributor limiter before Turnstile or persistence", async () => {
    const harness = createHarness({
      rateResults: [
        { allowed: true, retryAfterSeconds: 0 },
        { allowed: false, retryAfterSeconds: 73 },
      ],
    });
    const { config, fixture } = endpointCases()[1]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("73");
    expect(harness.consumeRateLimits).toHaveBeenCalledTimes(2);
    expect(harness.consumeRateLimits.mock.calls[0]?.[0].map(({ scope }) => scope)).toEqual([
      "anonymous-submission:global:10m",
      "anonymous-submission:global:24h",
    ]);
    expect(harness.consumeRateLimits.mock.calls[1]?.[0].map(({ scope }) => scope)).toEqual([
      "anonymous-submission:fit_confirmation:10m",
      "anonymous-submission:fit_confirmation:24h",
    ]);
    expect(harness.verifyChallenge).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it("returns a stable conflict without exposing the existing private record", async () => {
    const harness = createHarness({ persistError: new SubmissionIdempotencyConflictError() });
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(body).not.toContain("existing-private-id");
  });

  it("keeps print_failed separate from does_not_fit through persistence and hashing", async () => {
    const harness = createHarness();
    const fitCase = endpointCases()[1]!;
    await handleAnonymousSubmission(
      jsonRequest({ ...fitCase.fixture, idempotencyKey: "984e076d-fd95-45ae-bbee-ece3dcdb8020", outcome: "print_failed" }),
      fitCase.config,
      harness.dependencies,
    );
    await handleAnonymousSubmission(
      jsonRequest({ ...fitCase.fixture, idempotencyKey: "fca62f2f-c139-4642-b42c-6a46e1221da4", outcome: "does_not_fit" }),
      fitCase.config,
      harness.dependencies,
    );
    const [printFailure, fitFailure] = harness.persist.mock.calls.map(([input]) => input);
    expect(printFailure?.payload.outcome).toBe("print_failed");
    expect(fitFailure?.payload.outcome).toBe("does_not_fit");
    expect(printFailure?.contentFingerprint).not.toBe(fitFailure?.contentFingerprint);
  });

  it("separates complete request/contact fingerprinting from semantic queue deduplication", async () => {
    const harness = createHarness();
    const { config, fixture } = endpointCases()[0]!;
    await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    await handleAnonymousSubmission(jsonRequest({
      ...fixture,
      email: "other-person@example.invalid",
    }), config, harness.dependencies);
    const [original, changedContact] = harness.persist.mock.calls.map(([input]) => input);
    expect(original?.contentFingerprint).toBe(changedContact?.contentFingerprint);
    expect(original?.requestFingerprint).not.toBe(changedContact?.requestFingerprint);
    expect(original?.contributorKey).not.toBe(changedContact?.contributorKey);
  });

  it("never fetches a submitted source or evidence URL", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const harness = createHarness();
    const designCase = endpointCases()[2]!;
    await handleAnonymousSubmission(jsonRequest(designCase.fixture), designCase.config, harness.dependencies);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected persistence failures in both HTTP and structured logs", async () => {
    const sentinel = "postgres://user:secret@example.invalid/private-stack";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({ persistError: new Error(sentinel) });
    const { config, fixture } = endpointCases()[0]!;
    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      code: "ANONYMOUS_SUBMISSION_FAILURE",
      failureCode: "SUBMISSION_UNAVAILABLE",
      kind: "missing_part",
    }));
  });
});

function createHarness(options: {
  clientIp?: string;
  createReceiptId?: () => string;
  persistError?: Error;
  persistResult?: { duplicate: boolean; id: string; receiptId: string };
  rateResult?: { allowed: boolean; retryAfterSeconds: number };
  rateResults?: readonly { allowed: boolean; retryAfterSeconds: number }[];
} = {}) {
  let rateCallIndex = 0;
  const consumeRateLimits = vi.fn<AnonymousSubmissionPersistence["consumeRateLimits"]>(
    async () => options.rateResults?.[rateCallIndex++]
      ?? options.rateResult
      ?? { allowed: true, retryAfterSeconds: 0 },
  );
  const persist = vi.fn<AnonymousSubmissionPersistence["persist"]>(async () => {
    if (options.persistError) throw options.persistError;
    return options.persistResult ?? { duplicate: false, id: "private-id", receiptId };
  });
  const persistence: AnonymousSubmissionPersistence = { consumeRateLimits, persist };
  const verifyChallenge = vi.fn(async () => undefined);
  const dependencies: SubmissionApiDependencies = {
    createReceiptId: options.createReceiptId ?? (() => receiptId),
    getPersistence: async () => persistence,
    now: () => now,
    resolveClientIp: () => options.clientIp ?? "203.0.113.9",
    verifyChallenge,
  };
  return { consumeRateLimits, dependencies, persist, verifyChallenge };
}

function jsonRequest(payload: Record<string, unknown>, accept = "application/json") {
  return new NextRequest("https://repairprint.example/api/v1/submissions/requests", {
    body: JSON.stringify(payload),
    headers: {
      accept,
      "content-type": "application/json",
      origin: "https://repairprint.example",
    },
    method: "POST",
  });
}

function endpointCases() {
  const controls = {
    challengeToken: "verified-token",
    contributionConsent: true,
    emailFollowUpConsent: true,
    email: "person@example.invalid",
    idempotencyKey: "8f1dbf2c-3a55-4f7e-95c0-622293865f23",
    privacyConsent: true,
    website: "",
  };
  return [
    {
      config: { kind: "missing_part" as const, returnPath: "/request-part", schema: missingPartRequestIntakeSchema, turnstileAction: "missing_part" },
      fixture: { ...controls, brand: "DemoVac", brokenPart: "dust-bin latch", modelNumber: "DV-100" },
      kind: "missing part",
    },
    {
      config: { kind: "fit_confirmation" as const, returnPath: "/confirm-fit", schema: fitConfirmationIntakeSchema, turnstileAction: "fit_confirmation" },
      fixture: { ...controls, designRevision: "r2", modelNumber: "DV-100", outcome: "unsure", partSlug: "dust-bin-latch-r2" },
      kind: "fit confirmation",
    },
    {
      config: { kind: "design_submission" as const, returnPath: "/submit-design", schema: designSubmissionIntakeSchema, turnstileAction: "design_submission" },
      fixture: { ...controls, brand: "DemoVac", claimedLicense: "CC BY 4.0", componentName: "Dust-bin latch", creatorName: "Creator", modelNumber: "DV-100", sourceUrl: "https://example.invalid/design" },
      kind: "design submission",
    },
  ];
}
