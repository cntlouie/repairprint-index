import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { issueMediaCapability, mediaError, readBoundedMediaBody, requireMediaCapability } from "@/lib/private-media-api";

const config = Object.freeze({
  capabilitySecret: "ae6d906fb88b298403ce80c7d2ca02c7cc39f8b3701270a8b01bf3c51bfd368f", privateBucket: "private-bucket", privacyVersion: "privacy-v1",
  quarantineBucket: "quarantine-bucket", retentionDays: 30, retentionVersion: "retention-v1", termsVersion: "terms-v1",
});

describe("private media HTTP capability", () => {
  it("authorizes only the issued object and operation", () => {
    const now = new Date();
    const issued = issueMediaCapability("media_0123456789abcdefghijk", "upload", config, now, "nonce_0123456789abcdefghijk");
    const request = new NextRequest("https://repairprint.example/upload", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(requireMediaCapability(request, "media_0123456789abcdefghijk", "upload", config).nonce).toBe("nonce_0123456789abcdefghijk");
    expect(() => requireMediaCapability(request, "media_0123456789abcdefghijk", "finalize", config)).toThrow("MEDIA_CAPABILITY_SCOPE_INVALID");
  });

  it("never serializes raw errors, stacks, causes, object paths or credentials", async () => {
    const raw = new Error("postgres://operator:secret@example.invalid private/path.jpg");
    raw.stack = "PRIVATE_MEDIA_RAW_STACK";
    (raw as Error & { cause: unknown }).cause = { serviceRoleKey: "private-key" };
    const response = mediaError(raw);
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(body).toContain("MEDIA_UNAVAILABLE");
    for (const sentinel of ["operator", "secret", "private/path", "RAW_STACK", "serviceRoleKey", "private-key", "cause"]) expect(body).not.toContain(sentinel);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("reads the declared byte count through a bounded stream", async () => {
    const valid = new NextRequest("https://repairprint.example/upload", { method: "PUT", body: "abcd", headers: { "content-length": "4" } });
    expect(Buffer.from(await readBoundedMediaBody(valid, 4)).toString()).toBe("abcd");
    const overflow = new NextRequest("https://repairprint.example/upload", { method: "PUT", body: "abcd", headers: { "content-length": "3" } });
    await expect(readBoundedMediaBody(overflow, 3)).rejects.toThrow("MEDIA_SIZE_INVALID");
  });
});
