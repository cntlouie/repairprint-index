import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSubmissionProtectionConfigured,
  assertSubmissionOrigin,
  canonicalSubmissionClientIp,
  endpointSubmissionRateBuckets,
  globalSubmissionRateBuckets,
  MAX_SUBMISSION_BYTES,
  readSubmissionPayload,
  SubmissionIntakeError,
  submissionContactDigest,
  submissionContributorKey,
  submissionHmac,
  submissionIdempotencyActorKey,
  submissionSemanticContributorKey,
  trustedSubmissionClientIp,
  TURNSTILE_SITEVERIFY_URL,
  verifyTurnstile,
} from "@/lib/submission-security";

const originalEnvironment = { ...process.env };

describe("anonymous submission security", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_URL: "https://repairprint.example",
      SUBMISSION_HMAC_SECRET: "submission-test-secret-that-is-at-least-32-bytes",
    };
    delete process.env.VERCEL;
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it("trusts only Vercel's deployment-owned client header", () => {
    process.env.VERCEL = "1";
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.200",
      "x-real-ip": "203.0.113.201",
      "x-vercel-forwarded-for": "203.0.113.9",
    });
    expect(trustedSubmissionClientIp(request)).toBe("203.0.113.9");
  });

  it.each([
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
    [" 2001:0db8:0:0:0:0:0:1 ", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["::FFFF:203.0.113.9", "203.0.113.9"],
    ["::ffff:cb00:7109", "203.0.113.9"],
    ["203.0.113.9", "203.0.113.9"],
  ])("canonicalizes deployed client identity %s", (input, expected) => {
    process.env.VERCEL = "1";
    expect(trustedSubmissionClientIp(requestWithHeaders({ "x-vercel-forwarded-for": input }))).toBe(expected);
    expect(canonicalSubmissionClientIp(input)).toBe(expected);
  });

  it.each([
    undefined,
    "not-an-ip",
    "203.0.113.1, 203.0.113.2",
    "203.0.113.9:443",
    "[2001:db8::1]",
    "[2001:db8::1]:443",
    "2001:db8::1%eth0",
    "2001:db8::1%25eth0",
    "203.000.113.009",
  ])(
    "fails closed for invalid deployed client identity %s",
    (value) => {
      process.env.VERCEL = "1";
      const headers: Record<string, string> = {};
      if (value) headers["x-vercel-forwarded-for"] = value;
      expect(() => trustedSubmissionClientIp(requestWithHeaders(headers))).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_UNAVAILABLE" }),
      );
    },
  );

  it("allows only the configured exact origin", () => {
    expect(() => assertSubmissionOrigin(requestWithHeaders({ origin: "https://repairprint.example" }))).not.toThrow();
    for (const origin of [undefined, "null", "https://evil.example", "https://repairprint.example.evil.invalid"]) {
      const headers: Record<string, string> = {};
      if (origin) headers.origin = origin;
      expect(() => assertSubmissionOrigin(requestWithHeaders(headers))).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_ORIGIN_FORBIDDEN" }),
      );
    }
  });

  it("requires both public and server Turnstile configuration in production", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "public-site-key";
    process.env.TURNSTILE_SECRET_KEY = "server-secret";
    expect(() => assertSubmissionProtectionConfigured()).not.toThrow();
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(() => assertSubmissionProtectionConfigured()).toThrowError(
      expect.objectContaining({ code: "HUMAN_VERIFICATION_UNAVAILABLE" }),
    );
  });

  it("hashes identities deterministically without retaining the raw value", () => {
    const hash = submissionHmac("rate", "203.0.113.9");
    expect(hash).toHaveLength(64);
    expect(hash).toBe(submissionHmac("rate", "203.0.113.9"));
    expect(hash).not.toContain("203.0.113.9");
    expect(submissionHmac("different-purpose", "203.0.113.9")).not.toBe(hash);
  });

  it("derives stable canonical global and endpoint-contributor rate buckets", () => {
    const now = new Date("2026-07-12T12:03:00.000Z");
    const global = globalSubmissionRateBuckets("2001:0DB8:0:0:0:0:0:1", now);
    expect(global.map(({ limit, scope, windowSeconds }) => ({ limit, scope, windowSeconds }))).toEqual([
      { limit: 15, scope: "anonymous-submission:global:10m", windowSeconds: 600 },
      { limit: 60, scope: "anonymous-submission:global:24h", windowSeconds: 86400 },
    ]);
    expect(global[0]?.windowStartedAt.toISOString()).toBe("2026-07-12T12:00:00.000Z");
    expect(globalSubmissionRateBuckets("2001:db8::1", now)[0]?.subjectHash).toBe(global[0]?.subjectHash);
    expect(globalSubmissionRateBuckets("::ffff:cb00:7109", now)[0]?.subjectHash)
      .toBe(globalSubmissionRateBuckets("203.0.113.9", now)[0]?.subjectHash);
    const canonicalIpv6Contributor = submissionContributorKey("2001:db8::1");
    expect(submissionContributorKey(" 2001:0DB8:0:0:0:0:0:1 ")).toBe(canonicalIpv6Contributor);
    expect(submissionContributorKey("2001:0db8:0:0:0:0:0:1")).toBe(canonicalIpv6Contributor);
    expect(submissionContributorKey("::FFFF:203.0.113.9"))
      .toBe(submissionContributorKey("203.0.113.9"));
    expect(globalSubmissionRateBuckets("2001:db8::1", new Date("2026-07-12T12:10:00.000Z"))[0]?.subjectHash)
      .not.toBe(global[0]?.subjectHash);

    const contributorKey = submissionContributorKey("203.0.113.9", " PERSON@EXAMPLE.INVALID ");
    const endpoint = endpointSubmissionRateBuckets("missing_part", contributorKey, now);
    expect(endpoint.map(({ limit, scope, windowSeconds }) => ({ limit, scope, windowSeconds }))).toEqual([
      { limit: 5, scope: "anonymous-submission:missing_part:10m", windowSeconds: 600 },
      { limit: 20, scope: "anonymous-submission:missing_part:24h", windowSeconds: 86400 },
    ]);
    expect(submissionContributorKey("198.51.100.4", "person@example.invalid")).toBe(contributorKey);
    expect(endpointSubmissionRateBuckets("fit_confirmation", contributorKey, now)[0]?.subjectHash)
      .not.toBe(endpoint[0]?.subjectHash);
    expect(endpointSubmissionRateBuckets("missing_part", submissionContributorKey("203.0.113.10"), now)[0]?.subjectHash)
      .not.toBe(endpoint[0]?.subjectHash);
    expect(JSON.stringify([...global, ...endpoint])).not.toMatch(/2001:db8|203\.0\.113|person@example/i);
  });

  it("separates contact-independent idempotency actors from semantic contributor and contact keys", () => {
    const actor = submissionIdempotencyActorKey("203.0.113.9");
    expect(submissionIdempotencyActorKey("::ffff:cb00:7109")).toBe(actor);
    expect(submissionIdempotencyActorKey("203.0.113.10")).not.toBe(actor);
    expect(submissionSemanticContributorKey("203.0.113.9", "person@example.invalid"))
      .toBe(submissionSemanticContributorKey("198.51.100.4", " PERSON@EXAMPLE.INVALID "));
    expect(submissionSemanticContributorKey("203.0.113.9", "person@example.invalid")).not.toBe(actor);
    expect(submissionContactDigest(" PERSON@EXAMPLE.INVALID ")).toBe(
      submissionContactDigest("person@example.invalid"),
    );
    expect(submissionContactDigest("")).toBeUndefined();
    expect(new Set([
      actor,
      submissionSemanticContributorKey("203.0.113.9"),
      submissionContactDigest("person@example.invalid"),
    ]).size).toBe(3);
    expect(JSON.stringify({ actor, digest: submissionContactDigest("person@example.invalid") }))
      .not.toMatch(/203\.0\.113\.9|person@example/i);
  });

  it("keeps endpoint capacity independent under the global ceiling", () => {
    const now = new Date("2026-07-12T12:03:00.000Z");
    const clientIp = "203.0.113.9";
    const contributorKey = submissionContributorKey(clientIp);
    const counts = new Map<string, number>();
    const consume = (buckets: readonly {
      limit: number;
      scope: string;
      subjectHash: string;
      windowSeconds: number;
      windowStartedAt: Date;
    }[]) => {
      const allowed = buckets.every((bucket) => (counts.get(bucketKey(bucket)) ?? 0) < bucket.limit);
      if (allowed) for (const bucket of buckets) counts.set(bucketKey(bucket), (counts.get(bucketKey(bucket)) ?? 0) + 1);
      return allowed;
    };
    const attempt = (endpoint: "missing_part" | "fit_confirmation" | "design_submission") => {
      if (!consume(globalSubmissionRateBuckets(clientIp, now))) return false;
      return consume(endpointSubmissionRateBuckets(endpoint, contributorKey, now));
    };

    expect(Array.from({ length: 5 }, () => attempt("missing_part"))).toEqual([true, true, true, true, true]);
    expect(attempt("missing_part")).toBe(false);
    expect(Array.from({ length: 5 }, () => attempt("fit_confirmation"))).toEqual([true, true, true, true, true]);
    expect(Array.from({ length: 4 }, () => attempt("design_submission"))).toEqual([true, true, true, true]);
    expect(attempt("design_submission")).toBe(false);
  });

  it("freezes rate buckets and fails closed for invalid contributor inputs", () => {
    const now = new Date("2026-07-12T12:03:00.000Z");
    const buckets = globalSubmissionRateBuckets("203.0.113.9", now);
    expect(Object.isFrozen(buckets)).toBe(true);
    expect(buckets.every(Object.isFrozen)).toBe(true);
    expect(() => endpointSubmissionRateBuckets("missing_part", "raw-email@example.invalid", now)).toThrowError(
      expect.objectContaining({ code: "SUBMISSION_UNAVAILABLE" }),
    );
    expect(() => submissionContributorKey("not-an-ip")).toThrowError(
      expect.objectContaining({ code: "SUBMISSION_UNAVAILABLE" }),
    );
  });

  it("preserves the documented endpoint limits", () => {
    const buckets = endpointSubmissionRateBuckets(
      "missing_part",
      submissionContributorKey("203.0.113.9"),
      new Date("2026-07-12T12:03:00.000Z"),
    );
    expect(buckets.map(({ limit, windowSeconds }) => ({ limit, windowSeconds }))).toEqual([
      { limit: 5, windowSeconds: 600 },
      { limit: 20, windowSeconds: 86400 },
    ]);
  });

  it("accepts only JSON and URL-encoded bodies within the byte ceiling", async () => {
    await expect(readSubmissionPayload(postRequest("application/json", JSON.stringify({ field: "value" }))))
      .resolves.toEqual({ field: "value" });
    await expect(readSubmissionPayload(postRequest("application/x-www-form-urlencoded", "field=value")))
      .resolves.toEqual({ field: "value" });
    await expect(readSubmissionPayload(postRequest("text/plain", "field=value"))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    await expect(readSubmissionPayload(postRequest("application/json", "x".repeat(MAX_SUBMISSION_BYTES + 1))))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects compressed, duplicate-key and malformed bodies", async () => {
    const compressed = postRequest("application/json", "{}", { "content-encoding": "gzip" });
    await expect(readSubmissionPayload(compressed)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    await expect(readSubmissionPayload(postRequest("application/x-www-form-urlencoded", "field=one&field=two")))
      .rejects.toMatchObject({ code: "INVALID_SUBMISSION" });
    await expect(readSubmissionPayload(postRequest("application/json", "[1,2]")))
      .rejects.toMatchObject({ code: "INVALID_SUBMISSION" });
    await expect(readSubmissionPayload(postRequest("multipart/form-data; boundary=fixture", "--fixture")))
      .rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    await expect(readSubmissionPayload(postRequest("application/json", new Uint8Array([0xff]))))
      .rejects.toMatchObject({ code: "INVALID_SUBMISSION" });
    await expect(readSubmissionPayload(postRequest("application/json", "{}", {
      "content-length": String(MAX_SUBMISSION_BYTES + 1),
    }))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("uses only the fixed Siteverify endpoint and validates action plus hostname", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({
      action: "missing_part",
      hostname: "repairprint.example",
      success: true,
    }));
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "203.0.113.9", token: "token" },
      { fetchImplementation, hostname: "repairprint.example", secret: "turnstile-secret" },
    )).resolves.toBeUndefined();

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init).toMatchObject({ cache: "no-store", method: "POST", redirect: "error" });
    const body = init?.body as URLSearchParams;
    expect(body.get("response")).toBe("token");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it.each([
    { action: "wrong", hostname: "repairprint.example", success: true },
    { action: "missing_part", hostname: "evil.example", success: true },
    { action: "missing_part", hostname: "repairprint.example", success: false },
  ])("fails closed on an invalid Siteverify result %#", async (result) => {
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "203.0.113.9", token: "token" },
      {
        fetchImplementation: async () => Response.json(result),
        hostname: "repairprint.example",
        secret: "turnstile-secret",
      },
    )).rejects.toMatchObject({ code: "HUMAN_VERIFICATION_FAILED" });
  });

  it("maps provider/network details to a safe unavailable marker", async () => {
    const sentinel = "raw-provider-secret-sentinel";
    const failure = verifyTurnstile(
      { action: "missing_part", clientIp: "203.0.113.9", token: "token" },
      {
        fetchImplementation: async () => { throw new Error(sentinel); },
        hostname: "repairprint.example",
        secret: "turnstile-secret",
      },
    );
    await expect(failure).rejects.toEqual(expect.objectContaining({ code: "HUMAN_VERIFICATION_UNAVAILABLE" }));
    await failure.catch((error: SubmissionIntakeError) => expect(String(error)).not.toContain(sentinel));
  });

  it.each([
    async () => new Response("upstream unavailable", { status: 503 }),
    async () => new Response("not-json", { status: 200 }),
  ])("maps non-success and invalid provider responses to unavailable", async (fetchImplementation) => {
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "203.0.113.9", token: "token" },
      { fetchImplementation, hostname: "repairprint.example", secret: "turnstile-secret" },
    )).rejects.toMatchObject({ code: "HUMAN_VERIFICATION_UNAVAILABLE" });
  });

  it("aborts a timed-out Siteverify request and fails closed", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "203.0.113.9", token: "token" },
      { fetchImplementation, hostname: "repairprint.example", secret: "turnstile-secret", timeoutMilliseconds: 1 },
    )).rejects.toMatchObject({ code: "HUMAN_VERIFICATION_UNAVAILABLE" });
  });

  it("permits only the official dummy token on the explicit demo bypass", async () => {
    process.env.DEMO_MODE = "true";
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "127.0.0.1", token: "XXXX.DUMMY.TOKEN.XXXX" },
      { fetchImplementation },
    )).resolves.toBeUndefined();
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(verifyTurnstile(
      { action: "missing_part", clientIp: "127.0.0.1", token: "almost-dummy" },
      { fetchImplementation },
    )).rejects.toMatchObject({ code: "HUMAN_VERIFICATION_UNAVAILABLE" });
  });
});

function requestWithHeaders(headers: HeadersInit): NextRequest {
  return new NextRequest("https://repairprint.example/api/v1/submissions/requests", { headers });
}

function postRequest(contentType: string, body: BodyInit, headers: HeadersInit = {}): NextRequest {
  return new NextRequest("https://repairprint.example/api/v1/submissions/requests", {
    body,
    headers: { "content-type": contentType, ...headers },
    method: "POST",
  });
}

function bucketKey(bucket: {
  scope: string;
  subjectHash: string;
  windowSeconds: number;
  windowStartedAt: Date;
}): string {
  return [bucket.scope, bucket.subjectHash, bucket.windowStartedAt.toISOString(), bucket.windowSeconds].join("|");
}
