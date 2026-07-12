import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSubmissionProtectionConfigured,
  assertSubmissionOrigin,
  MAX_SUBMISSION_BYTES,
  readSubmissionPayload,
  SubmissionIntakeError,
  submissionHmac,
  submissionRateBuckets,
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

  it.each([undefined, "not-an-ip", "203.0.113.1, 203.0.113.2"])(
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

  it("derives stable window-scoped short and daily rate buckets", () => {
    const now = new Date("2026-07-12T12:03:00.000Z");
    const buckets = submissionRateBuckets("203.0.113.9", now);
    expect(buckets.map(({ limit, windowSeconds }) => ({ limit, windowSeconds }))).toEqual([
      { limit: 5, windowSeconds: 600 },
      { limit: 20, windowSeconds: 86400 },
    ]);
    expect(buckets[0]?.windowStartedAt.toISOString()).toBe("2026-07-12T12:00:00.000Z");
    expect(submissionRateBuckets("203.0.113.9", now)[0]?.subjectHash).toBe(buckets[0]?.subjectHash);
    expect(submissionRateBuckets("203.0.113.9", new Date("2026-07-12T12:10:00.000Z"))[0]?.subjectHash)
      .not.toBe(buckets[0]?.subjectHash);
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
