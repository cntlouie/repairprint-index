import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleBrowserAnalyticsEvent } from "@/app/api/v1/analytics/events/route";

const originalEnvironment = { ...process.env };
const validEvent = {
  name: "search_submitted",
  properties: { normalizedCategory: "identifier", queryLength: 6, identifierLike: true },
} as const;

describe("browser analytics API", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DEMO_MODE: "true",
      NEXT_PUBLIC_SITE_URL: "https://repairprint.example",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it("accepts a strict allowlisted event with private response headers", async () => {
    const record = vi.fn().mockResolvedValue("disabled");
    const response = await handleBrowserAnalyticsEvent(request(validEvent), record);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(record).toHaveBeenCalledWith(validEvent);
  });

  it.each([
    ["unknown event", { name: "unknown", properties: {} }],
    ["sensitive property", { ...validEvent, properties: { ...validEvent.properties, query: "PRIVATE-100" } }],
    ["server-only completion", { name: "design_submitted", properties: { sourcePlatform: "printables" } }],
    ["excessive value", { name: "part_viewed", properties: { publicId: "x".repeat(121), confidenceTier: "verified_fit", safetyClass: "low" } }],
  ])("rejects %s", async (_label, body) => {
    const record = vi.fn();
    const response = await handleBrowserAnalyticsEvent(request(body), record);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_ANALYTICS_EVENT" } });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 403],
    ["null", 403],
    ["https://attacker.example", 403],
  ])("rejects the origin %s", async (origin, status) => {
    const response = await handleBrowserAnalyticsEvent(request(validEvent, { origin }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: "ANALYTICS_ORIGIN_FORBIDDEN" } });
  });

  it("fails closed on an invalid configured production origin", async () => {
    process.env.DEMO_MODE = "false";
    process.env.NEXT_PUBLIC_SITE_URL = "https://repairprint.example/path";
    const response = await handleBrowserAnalyticsEvent(request(validEvent));
    expect(response.status).toBe(403);
  });

  it.each([
    ["text/plain", undefined, "UNSUPPORTED_MEDIA_TYPE", 415],
    ["application/json", "gzip", "UNSUPPORTED_MEDIA_TYPE", 415],
  ])("rejects media type %s with encoding %s", async (contentType, contentEncoding, code, status) => {
    const response = await handleBrowserAnalyticsEvent(request(validEvent, { contentEncoding, contentType }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  });

  it("rejects declared and streamed oversized payloads", async () => {
    const declared = await handleBrowserAnalyticsEvent(request(validEvent, { contentLength: "4097" }));
    expect(declared.status).toBe(413);

    const streamed = await handleBrowserAnalyticsEvent(request({ padding: "x".repeat(4_100) }));
    expect(streamed.status).toBe(413);
  });

  it("returns success when the injected recorder fails and never logs the underlying error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const record = vi.fn().mockRejectedValue(new Error("PRIVATE-100"));
    const response = await handleBrowserAnalyticsEvent(request(validEvent), record);

    expect(response.status).toBe(202);
    expect(error).toHaveBeenCalledWith({
      code: "ANALYTICS_EVENT_DROPPED",
      eventName: "search_submitted",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("PRIVATE-100");
  });
});

function request(
  body: unknown,
  options: Readonly<{
    contentEncoding?: string | undefined;
    contentLength?: string | undefined;
    contentType?: string | undefined;
    origin?: string | undefined;
  }> = {},
): NextRequest {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
  });
  if (options.contentEncoding !== undefined) headers.set("content-encoding", options.contentEncoding);
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  else if (!("origin" in options)) headers.set("origin", "https://repairprint.example");

  return new NextRequest("https://repairprint.example/api/v1/analytics/events", {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}
