import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postDesign } from "@/app/api/v1/submissions/designs/route";
import { POST as postFitConfirmation } from "@/app/api/v1/submissions/fit-confirmations/route";
import { POST as postRequest } from "@/app/api/v1/submissions/requests/route";
import { handleAnonymousSubmission, type SubmissionApiDependencies } from "@/lib/submission-api";
import {
  designSubmissionIntakeStructuralSchema,
  fitConfirmationIntakeStructuralSchema,
  missingPartRequestIntakeStructuralSchema,
} from "@/lib/submission-schemas";
import {
  endpointSubmissionRateBuckets,
  globalSubmissionRateBuckets,
  submissionHmac,
  submissionIdempotencyActorKey,
  submissionSemanticContributorKey,
} from "@/lib/submission-security";
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
      SUBMISSION_HMAC_SECRET: randomBytes(32).toString("hex"),
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
    expect(honeypot.consumeRateLimits).not.toHaveBeenCalled();
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

  it.each(endpointCases())(
    "returns the stored receipt for an exact $kind retry after rate limiting and verification",
    async ({ config, fixture }) => {
      const first = createHarness();
      const created = await handleAnonymousSubmission(jsonRequest(fixture), config, first.dependencies);
      const persisted = first.persist.mock.calls[0]![0];
      const restarted = createHarness({
        findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
      });

      const retried = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, challengeToken: "fresh-valid-token" }),
        config,
        restarted.dependencies,
      );

      expect(await created.json()).toEqual({ id: receiptId, status: "pending" });
      expect(await retried.json()).toEqual({ id: receiptId, status: "pending" });
      expect(restarted.consumeRateLimits).toHaveBeenCalledTimes(2);
      expect(restarted.verifyChallenge).toHaveBeenCalledOnce();
      expect(restarted.findIdempotency).toHaveBeenCalledWith({
        idempotencyActorKey: persisted.idempotencyActorKey,
        idempotencyKeyHash: persisted.idempotencyKeyHash,
        kind: config.kind,
      });
      expect(restarted.persist).not.toHaveBeenCalled();
    },
  );

  it.each(endpointCases())(
    "uses the canonical client UUID for every $kind handler identity operation",
    async ({ config, fixture }) => {
      const canonicalKey = String(fixture.idempotencyKey);
      const first = createHarness();
      const created = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: canonicalKey.toUpperCase() }),
        config,
        first.dependencies,
      );
      const persisted = first.persist.mock.calls[0]![0];
      expect(created.status).toBe(202);
      expect(persisted.idempotencyKeyHash).toBe(submissionHmac("idempotency-key", canonicalKey));

      const exact = createHarness({
        findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
      });
      const exactResponse = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: canonicalKey }),
        config,
        exact.dependencies,
      );
      expect(await exactResponse.json()).toEqual({ id: receiptId, status: "pending" });
      expect(exact.findIdempotency).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKeyHash: persisted.idempotencyKeyHash,
      }));
      expect(exact.persist).not.toHaveBeenCalled();

      const reverseFirst = createHarness();
      await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: canonicalKey }),
        config,
        reverseFirst.dependencies,
      );
      const reversePersisted = reverseFirst.persist.mock.calls[0]![0];
      const reverseExact = createHarness({
        findResult: { receiptId, requestFingerprint: reversePersisted.requestFingerprint },
      });
      const reverseResponse = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: canonicalKey.toUpperCase() }),
        config,
        reverseExact.dependencies,
      );
      expect(await reverseResponse.json()).toEqual({ id: receiptId, status: "pending" });
      expect(reverseExact.findIdempotency).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKeyHash: reversePersisted.idempotencyKeyHash,
      }));
      expect(reverseExact.persist).not.toHaveBeenCalled();

      for (const changedFacts of [
        { modelNumber: `${fixture.modelNumber}-changed` },
        { email: "different-person@example.invalid" },
        { privacyConsent: false },
      ]) {
        const changed = createHarness({
          findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
        });
        const response = await handleAnonymousSubmission(
          jsonRequest({ ...fixture, ...changedFacts, idempotencyKey: canonicalKey }),
          config,
          changed.dependencies,
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "IDEMPOTENCY_KEY_REUSED" },
        });
        expect(changed.findIdempotency).toHaveBeenCalledWith(expect.objectContaining({
          idempotencyKeyHash: persisted.idempotencyKeyHash,
        }));
        expect(changed.persist).not.toHaveBeenCalled();
      }
    },
  );

  it.each(idempotencyConflictCases())(
    "returns 409 for an existing $kind token when $change changes",
    async ({ config, initial, retry }) => {
      const first = createHarness();
      await handleAnonymousSubmission(jsonRequest(initial), config, first.dependencies);
      const persisted = first.persist.mock.calls[0]![0];
      const restarted = createHarness({
        findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
      });

      const response = await handleAnonymousSubmission(jsonRequest(retry), config, restarted.dependencies);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      expect(restarted.consumeRateLimits).toHaveBeenCalledTimes(2);
      expect(restarted.verifyChallenge).toHaveBeenCalledOnce();
      expect(restarted.findIdempotency).toHaveBeenCalledOnce();
      expect(restarted.findIdempotency.mock.calls[0]?.[0].idempotencyActorKey)
        .toBe(persisted.idempotencyActorKey);
      expect(restarted.persist).not.toHaveBeenCalled();
    },
  );

  it.each(endpointCases())(
    "normalizes contact and checkbox decisions for an exact $kind retry",
    async ({ config, fixture }) => {
      const first = createHarness();
      await handleAnonymousSubmission(jsonRequest(fixture), config, first.dependencies);
      const persisted = first.persist.mock.calls[0]![0];
      const restarted = createHarness({
        findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
      });

      const response = await handleAnonymousSubmission(jsonRequest({
        ...fixture,
        contributionConsent: "on",
        email: " PERSON@EXAMPLE.INVALID ",
        emailFollowUpConsent: "1",
        privacyConsent: "true",
      }), config, restarted.dependencies);

      expect(response.status).toBe(202);
      expect(restarted.persist).not.toHaveBeenCalled();
    },
  );

  it.each(optionalFieldNormalizationCases())(
    "normalizes omitted and explicitly empty optional fields for an exact $kind retry",
    async ({ config, emptyOptionals, fixture }) => {
      const first = createHarness();
      await handleAnonymousSubmission(jsonRequest(fixture), config, first.dependencies);
      const persisted = first.persist.mock.calls[0]![0];
      const restarted = createHarness({
        findResult: { receiptId, requestFingerprint: persisted.requestFingerprint },
      });

      const response = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, ...emptyOptionals }),
        config,
        restarted.dependencies,
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ id: receiptId, status: "pending" });
      expect(restarted.persist).not.toHaveBeenCalled();
    },
  );

  it.each(endpointCases())(
    "scopes $kind idempotency to the network actor without placing network identity in the fingerprint",
    async ({ config, fixture }) => {
      const left = createHarness({ clientIp: "203.0.113.9" });
      const right = createHarness({ clientIp: "203.0.113.10" });
      const noContact = { ...fixture, email: "", emailFollowUpConsent: false, modelNumber: "DV100" };
      await handleAnonymousSubmission(jsonRequest(noContact), config, left.dependencies);
      await handleAnonymousSubmission(jsonRequest(noContact), config, right.dependencies);
      const leftInput = left.persist.mock.calls[0]?.[0];
      const rightInput = right.persist.mock.calls[0]?.[0];
      expect(leftInput?.payload.modelNumber).toBe("DV100");
      expect(leftInput?.contributorKey).not.toBe(rightInput?.contributorKey);
      expect(leftInput?.idempotencyActorKey).not.toBe(rightInput?.idempotencyActorKey);
      expect(leftInput?.idempotencyKeyHash).toBe(rightInput?.idempotencyKeyHash);
      expect(leftInput?.requestFingerprint).toBe(rightInput?.requestFingerprint);
    },
  );

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

  it.each(newSubmissionConsentFailureCases())(
    "rejects a new $kind when $decision is not accepted",
    async ({ config, fixture }) => {
      const harness = createHarness();
      const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "CONSENT_REQUIRED" } });
      expect(harness.verifyChallenge).toHaveBeenCalledOnce();
      expect(harness.findIdempotency).toHaveBeenCalledOnce();
      expect(harness.persist).not.toHaveBeenCalled();
    },
  );

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

  it("recovers an exact retry that races between lookup and insert", async () => {
    const { config, fixture } = endpointCases()[0]!;
    const first = createHarness();
    await handleAnonymousSubmission(jsonRequest(fixture), config, first.dependencies);
    const persisted = first.persist.mock.calls[0]![0];
    const raced = createHarness({
      findResults: [
        null,
        { receiptId, requestFingerprint: persisted.requestFingerprint },
      ],
      persistError: new SubmissionIdempotencyConflictError(),
    });

    const response = await handleAnonymousSubmission(jsonRequest(fixture), config, raced.dependencies);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ id: receiptId, status: "pending" });
    expect(raced.findIdempotency).toHaveBeenCalledTimes(2);
    expect(raced.persist).toHaveBeenCalledOnce();
  });

  it.each(endpointCases())(
    "durably binds every semantic-dedupe UUID for $kind and closes reuse and race escapes",
    async ({ config, fixture }) => {
      const harness = createSemanticBindingHarness();
      const keyTwo = "2b1f71c5-77d3-4fbd-8de8-e58638c1b7a2";
      const keyThree = "5ad4b76e-9c10-4a69-b0e5-b584679bb08a";
      const keyFour = "7f2f0c0d-0ad6-4f0b-967f-b63274252d70";

      const first = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
      const semanticDuplicate = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: keyTwo }),
        config,
        harness.dependencies,
      );
      expect(await first.json()).toEqual({ id: receiptId, status: "pending" });
      expect(await semanticDuplicate.json()).toEqual({ id: receiptId, status: "pending" });
      expect(harness.bindingFor(config.kind, "203.0.113.9", keyTwo)).toMatchObject({
        receiptId,
      });
      const persistCallsAfterBinding = harness.persist.mock.calls.length;

      for (const changed of [
        { ...fixture, email: "another-person@example.invalid", idempotencyKey: keyTwo },
        { ...fixture, email: "", emailFollowUpConsent: false, idempotencyKey: keyTwo },
        { ...fixture, emailFollowUpConsent: false, idempotencyKey: keyTwo },
        { ...fixture, contributionConsent: false, idempotencyKey: keyTwo },
        { ...fixture, privacyConsent: false, idempotencyKey: keyTwo },
      ]) {
        const conflict = await handleAnonymousSubmission(jsonRequest(changed), config, harness.dependencies);
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({
          error: { code: "IDEMPOTENCY_KEY_REUSED" },
        });
      }
      expect(harness.persist).toHaveBeenCalledTimes(persistCallsAfterBinding);

      const exactRetry = await handleAnonymousSubmission(
        jsonRequest({ ...fixture, idempotencyKey: keyTwo }),
        config,
        harness.dependencies,
      );
      expect(await exactRetry.json()).toEqual({ id: receiptId, status: "pending" });

      const exactRace = await Promise.all([
        handleAnonymousSubmission(
          jsonRequest({ ...fixture, idempotencyKey: keyThree }),
          config,
          harness.dependencies,
        ),
        handleAnonymousSubmission(
          jsonRequest({ ...fixture, idempotencyKey: keyThree, challengeToken: "race-token" }),
          config,
          harness.dependencies,
        ),
      ]);
      expect(exactRace.map(({ status }) => status)).toEqual([202, 202]);
      expect(await Promise.all(exactRace.map((response) => response.json()))).toEqual([
        { id: receiptId, status: "pending" },
        { id: receiptId, status: "pending" },
      ]);

      const mixedRacePayloads = [
        { ...fixture, idempotencyKey: keyFour },
        {
          ...fixture,
          email: "racing-person@example.invalid",
          idempotencyKey: keyFour,
        },
      ];
      const mixedRace = await Promise.all(mixedRacePayloads.map((racePayload) =>
        handleAnonymousSubmission(
          jsonRequest(racePayload),
          config,
          harness.dependencies,
        )));
      expect(mixedRace.map(({ status }) => status).sort()).toEqual([202, 409]);
      const mixedRaceWinner = mixedRace.findIndex(({ status }) => status === 202);
      const authoritative = harness.bindingFor(config.kind, "203.0.113.9", keyFour);
      expect(authoritative).toBeDefined();
      await expect(mixedRace[mixedRaceWinner]!.json()).resolves.toMatchObject({
        id: authoritative!.receiptId,
      });
      const authoritativeRetry = await handleAnonymousSubmission(
        jsonRequest(mixedRacePayloads[mixedRaceWinner]!),
        config,
        harness.dependencies,
      );
      await expect(authoritativeRetry.json()).resolves.toMatchObject({
        id: authoritative!.receiptId,
      });
      expect(harness.bindingCount()).toBe(4);
    },
  );

  it.each(endpointCases())(
    "includes the effective retention-policy version but excludes times and client UUIDs for $kind",
    async ({ config, fixture }) => {
      const first = createHarness({ now });
      await handleAnonymousSubmission(jsonRequest(fixture), config, first.dependencies);
      const original = first.persist.mock.calls[0]![0];

      const later = createHarness({ now: new Date("2026-07-13T15:45:00.000Z") });
      await handleAnonymousSubmission(jsonRequest({
        ...fixture,
        challengeToken: "another-valid-token",
        idempotencyKey: "2b1f71c5-77d3-4fbd-8de8-e58638c1b7a2",
      }), config, later.dependencies);
      const laterInput = later.persist.mock.calls[0]![0];

      expect(laterInput.idempotencyKeyHash).not.toBe(original.idempotencyKeyHash);
      expect(laterInput.retentionExpiresAt).not.toEqual(original.retentionExpiresAt);
      expect(laterInput.requestFingerprint).toBe(original.requestFingerprint);

      process.env.SUBMISSION_RETENTION_POLICY_VERSION = "wp08-test-retention-v2";
      const changedPolicy = createHarness({
        findResult: { receiptId, requestFingerprint: original.requestFingerprint },
      });
      const changedPolicyResponse = await handleAnonymousSubmission(
        jsonRequest(fixture),
        config,
        changedPolicy.dependencies,
      );
      expect(changedPolicyResponse.status).toBe(409);
    },
  );

  it("scopes the same UUID independently by endpoint kind and network actor", async () => {
    const [requestCase, fitCase] = endpointCases();
    const requestHarness = createHarness({ clientIp: "203.0.113.9" });
    const fitHarness = createHarness({ clientIp: "203.0.113.9" });
    const otherNetworkHarness = createHarness({ clientIp: "203.0.113.10" });

    expect((await handleAnonymousSubmission(
      jsonRequest(requestCase!.fixture),
      requestCase!.config,
      requestHarness.dependencies,
    )).status).toBe(202);
    expect((await handleAnonymousSubmission(
      jsonRequest(fitCase!.fixture),
      fitCase!.config,
      fitHarness.dependencies,
    )).status).toBe(202);
    expect((await handleAnonymousSubmission(
      jsonRequest(requestCase!.fixture),
      requestCase!.config,
      otherNetworkHarness.dependencies,
    )).status).toBe(202);

    const requestInput = requestHarness.persist.mock.calls[0]![0];
    const fitInput = fitHarness.persist.mock.calls[0]![0];
    const otherNetworkInput = otherNetworkHarness.persist.mock.calls[0]![0];
    expect(requestInput.idempotencyKeyHash).toBe(fitInput.idempotencyKeyHash);
    expect(requestInput.idempotencyActorKey).toBe(fitInput.idempotencyActorKey);
    expect(requestInput.kind).not.toBe(fitInput.kind);
    expect(otherNetworkInput.idempotencyKeyHash).toBe(requestInput.idempotencyKeyHash);
    expect(otherNetworkInput.idempotencyActorKey).not.toBe(requestInput.idempotencyActorKey);
    expect(otherNetworkInput.requestFingerprint).toBe(requestInput.requestFingerprint);
  });

  it.each(endpointCases())(
    "keeps actor and contact material keyed and out of opaque $kind responses",
    async ({ config, fixture }) => {
      const harness = createHarness();
      const response = await handleAnonymousSubmission(jsonRequest(fixture), config, harness.dependencies);
      const persisted = harness.persist.mock.calls[0]![0];
      const body = await response.text();

      expect(persisted.idempotencyActorKey).toBe(submissionIdempotencyActorKey("203.0.113.9"));
      expect(persisted.contributorKey).toBe(
        submissionSemanticContributorKey("203.0.113.9", "person@example.invalid"),
      );
      expect(persisted.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(persisted.requestFingerprint).not.toContain("person@example.invalid");
      expect(body).not.toMatch(/person@example|203\.0\.113\.9|idempotencyActorKey|requestFingerprint/i);
    },
  );

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
  findResult?: { intakeId?: string; receiptId: string; requestFingerprint: string } | null;
  findResults?: readonly ({ intakeId?: string; receiptId: string; requestFingerprint: string } | null)[];
  now?: Date;
  persistError?: Error;
  persistResult?: { duplicate: boolean; id: string; intakeId?: string; receiptId: string; requestFingerprint?: string };
  rateResult?: { allowed: boolean; retryAfterSeconds: number };
  rateResults?: readonly { allowed: boolean; retryAfterSeconds: number }[];
} = {}) {
  let rateCallIndex = 0;
  let findCallIndex = 0;
  const consumeRateLimits = vi.fn<AnonymousSubmissionPersistence["consumeRateLimits"]>(
    async () => options.rateResults?.[rateCallIndex++]
      ?? options.rateResult
      ?? { allowed: true, retryAfterSeconds: 0 },
  );
  const findIdempotency = vi.fn<AnonymousSubmissionPersistence["findIdempotency"]>(
    async () => {
      const result = options.findResults?.[findCallIndex++] ?? options.findResult ?? null;
      return result ? { ...result, intakeId: result.intakeId ?? "private-intake-id" } : null;
    },
  );
  const persist = vi.fn<AnonymousSubmissionPersistence["persist"]>(async (input) => {
    if (options.persistError) throw options.persistError;
    return {
      duplicate: options.persistResult?.duplicate ?? false,
      id: options.persistResult?.id ?? "private-id",
      intakeId: options.persistResult?.intakeId ?? "private-intake-id",
      receiptId: options.persistResult?.receiptId ?? receiptId,
      requestFingerprint: options.persistResult?.requestFingerprint ?? input.requestFingerprint,
    };
  });
  const verifyHmacKeyPin = vi.fn<AnonymousSubmissionPersistence["verifyHmacKeyPin"]>(async () => undefined);
  const persistence: AnonymousSubmissionPersistence = {
    consumeRateLimits,
    findIdempotency,
    persist,
    verifyHmacKeyPin,
  };
  const verifyChallenge = vi.fn(async () => undefined);
  const dependencies: SubmissionApiDependencies = {
    createReceiptId: options.createReceiptId ?? (() => receiptId),
    getPersistence: async () => persistence,
    now: () => options.now ?? now,
    resolveClientIp: () => options.clientIp ?? "203.0.113.9",
    verifyChallenge,
  };
  return { consumeRateLimits, dependencies, findIdempotency, persist, verifyChallenge, verifyHmacKeyPin };
}

function createSemanticBindingHarness() {
  type PersistInput = Parameters<AnonymousSubmissionPersistence["persist"]>[0];
  type Binding = Readonly<{
    id: string;
    intakeId: string;
    receiptId: string;
    requestFingerprint: string;
  }>;

  const bindings = new Map<string, Binding>();
  const semanticRows = new Map<string, Readonly<{ id: string; receiptId: string }>>();
  const bindingKey = (input: Readonly<{
    idempotencyActorKey: string;
    idempotencyKeyHash: string;
    kind: string;
  }>) => JSON.stringify([input.kind, input.idempotencyActorKey, input.idempotencyKeyHash]);
  const semanticKey = (input: PersistInput) => JSON.stringify([
    input.kind,
    input.contributorKey,
    input.contentFingerprint,
  ]);

  const consumeRateLimits = vi.fn<AnonymousSubmissionPersistence["consumeRateLimits"]>(
    async () => ({ allowed: true, retryAfterSeconds: 0 }),
  );
  const findIdempotency = vi.fn<AnonymousSubmissionPersistence["findIdempotency"]>(async (input) => {
    const binding = bindings.get(bindingKey(input));
    return binding
      ? Object.freeze({
        intakeId: binding.intakeId,
        receiptId: binding.receiptId,
        requestFingerprint: binding.requestFingerprint,
      })
      : null;
  });
  const persist = vi.fn<AnonymousSubmissionPersistence["persist"]>(async (input) => {
    // Let concurrent handler calls complete their preflight lookup before the
    // in-memory transaction serializes binding creation.
    await Promise.resolve();
    const key = bindingKey(input);
    const authoritative = bindings.get(key);
    if (authoritative) {
      if (authoritative.requestFingerprint !== input.requestFingerprint) {
        throw new SubmissionIdempotencyConflictError();
      }
      return Object.freeze({ duplicate: true, ...authoritative });
    }

    const semantic = semanticRows.get(semanticKey(input));
    const row = semantic ?? Object.freeze({
      id: `private-semantic-${semanticRows.size + 1}`,
      receiptId: semanticRows.size === 0 ? receiptId : `semantic-receipt-${semanticRows.size + 1}`,
    });
    if (!semantic) semanticRows.set(semanticKey(input), row);
    const binding = Object.freeze({
      ...row,
      intakeId: `private-intake-${bindings.size + 1}`,
      requestFingerprint: input.requestFingerprint,
    });
    bindings.set(key, binding);
    return Object.freeze({ duplicate: Boolean(semantic), ...binding });
  });
  const verifyHmacKeyPin = vi.fn<AnonymousSubmissionPersistence["verifyHmacKeyPin"]>(async () => undefined);
  const persistence: AnonymousSubmissionPersistence = {
    consumeRateLimits,
    findIdempotency,
    persist,
    verifyHmacKeyPin,
  };
  const verifyChallenge = vi.fn(async () => undefined);
  const dependencies: SubmissionApiDependencies = {
    createReceiptId: () => receiptId,
    getPersistence: async () => persistence,
    now: () => now,
    resolveClientIp: () => "203.0.113.9",
    verifyChallenge,
  };

  return {
    bindingCount: () => bindings.size,
    bindingFor: (kind: "missing_part" | "fit_confirmation" | "design_submission", clientIp: string, key: string) =>
      bindings.get(bindingKey({
        idempotencyActorKey: submissionIdempotencyActorKey(clientIp),
        idempotencyKeyHash: submissionHmac("idempotency-key", key),
        kind,
      })),
    dependencies,
    findIdempotency,
    persist,
  };
}

function idempotencyConflictCases() {
  return endpointCases().flatMap(({ config, fixture, kind }) => [
    {
      change: "normalized contact identity",
      config,
      initial: fixture,
      kind,
      retry: { ...fixture, email: "another-person@example.invalid" },
    },
    {
      change: "contact removal",
      config,
      initial: fixture,
      kind,
      retry: { ...fixture, email: "", emailFollowUpConsent: false },
    },
    {
      change: "contact addition",
      config,
      initial: { ...fixture, email: "", emailFollowUpConsent: false },
      kind,
      retry: fixture,
    },
    {
      change: "privacy consent",
      config,
      initial: fixture,
      kind,
      retry: { ...fixture, privacyConsent: false },
    },
    {
      change: "contribution consent",
      config,
      initial: fixture,
      kind,
      retry: { ...fixture, contributionConsent: false },
    },
    {
      change: "email follow-up consent",
      config,
      initial: fixture,
      kind,
      retry: { ...fixture, emailFollowUpConsent: false },
    },
  ]);
}

function newSubmissionConsentFailureCases() {
  return endpointCases().flatMap(({ config, fixture, kind }) => [
    { config, decision: "privacy consent", fixture: { ...fixture, privacyConsent: false }, kind },
    { config, decision: "contribution consent", fixture: { ...fixture, contributionConsent: false }, kind },
    { config, decision: "email follow-up consent", fixture: { ...fixture, emailFollowUpConsent: false }, kind },
  ]);
}

function optionalFieldNormalizationCases() {
  return endpointCases().map(({ config, fixture, kind }, index) => ({
    config,
    emptyOptionals: [
      { notes: "", oemPartNumber: "" },
      { evidenceUrl: "", modificationNotes: "", printSettings: "" },
      { notes: "" },
    ][index]!,
    fixture,
    kind,
  }));
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
      config: { kind: "missing_part" as const, returnPath: "/request-part", structuralSchema: missingPartRequestIntakeStructuralSchema, turnstileAction: "missing_part" },
      fixture: { ...controls, brand: "DemoVac", brokenPart: "dust-bin latch", modelNumber: "DV-100" },
      kind: "missing part",
    },
    {
      config: { kind: "fit_confirmation" as const, returnPath: "/confirm-fit", structuralSchema: fitConfirmationIntakeStructuralSchema, turnstileAction: "fit_confirmation" },
      fixture: { ...controls, designRevision: "r2", modelNumber: "DV-100", outcome: "unsure", partSlug: "dust-bin-latch-r2" },
      kind: "fit confirmation",
    },
    {
      config: { kind: "design_submission" as const, returnPath: "/submit-design", structuralSchema: designSubmissionIntakeStructuralSchema, turnstileAction: "design_submission" },
      fixture: { ...controls, brand: "DemoVac", claimedLicense: "CC BY 4.0", componentName: "Dust-bin latch", creatorName: "Creator", modelNumber: "DV-100", sourceUrl: "https://example.invalid/design" },
      kind: "design submission",
    },
  ];
}
