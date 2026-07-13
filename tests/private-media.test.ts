import { describe, expect, it } from "vitest";

import {
  assertExactContainer,
  canonicalMediaIdempotencyKey,
  detectPrivateMediaType,
  parseMediaCapabilitySecret,
  signMediaCapability,
  validateRedactionRectangles,
  verifyMediaCapability,
} from "@/domain/private-media";

const secret = "ae6d906fb88b298403ce80c7d2ca02c7cc39f8b3701270a8b01bf3c51bfd368f";
const now = new Date("2026-07-13T12:00:00Z");
const claims = {
  issuedAt: Math.floor(now.getTime() / 1000),
  expiresAt: Math.floor(now.getTime() / 1000) + 300,
  mediaPublicId: "media_0123456789abcdefghijk",
  nonce: "nonce_0123456789abcdefghijk",
  operation: "upload" as const,
};

describe("private media capability", () => {
  it("is short lived and bound to one object and operation", () => {
    const token = signMediaCapability(claims, secret);
    expect(verifyMediaCapability(token, { mediaPublicId: claims.mediaPublicId, operation: "upload" }, secret, now)).toEqual(claims);
    expect(() => verifyMediaCapability(token, { mediaPublicId: "media_zzzzzzzzzzzzzzzzzzzzz", operation: "upload" }, secret, now)).toThrow("MEDIA_CAPABILITY_SCOPE_INVALID");
    expect(() => verifyMediaCapability(token, { mediaPublicId: claims.mediaPublicId, operation: "finalize" }, secret, now)).toThrow("MEDIA_CAPABILITY_SCOPE_INVALID");
    expect(() => verifyMediaCapability(token, { mediaPublicId: claims.mediaPublicId, operation: "upload" }, secret, new Date(now.getTime() + 301_000))).toThrow("MEDIA_CAPABILITY_EXPIRED");
  });

  it("rejects tampering and capabilities with excessive lifetime", () => {
    const token = signMediaCapability(claims, secret);
    expect(() => verifyMediaCapability(`${token}x`, { mediaPublicId: claims.mediaPublicId, operation: "upload" }, secret, now)).toThrow("MEDIA_CAPABILITY_INVALID");
    expect(() => signMediaCapability({ ...claims, expiresAt: claims.issuedAt + 301 }, secret)).toThrow("MEDIA_CAPABILITY_INVALID");
  });
});

describe("private image containers", () => {
  it("recognizes supported magic and rejects appended JPEG payloads", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(detectPrivateMediaType(jpeg)).toBe("image/jpeg");
    expect(() => assertExactContainer(jpeg, "image/jpeg")).not.toThrow();
    expect(() => assertExactContainer(Uint8Array.from([...jpeg, 1]), "image/jpeg")).toThrow("MEDIA_CONTAINER_INVALID");
    expect(() => assertExactContainer(Uint8Array.from([...jpeg, 1, 2, 3, 0xff, 0xd9]), "image/jpeg")).toThrow("MEDIA_CONTAINER_INVALID");
  });

  it("rejects unknown bytes", () => expect(() => detectPrivateMediaType(new Uint8Array(20))).toThrow("MEDIA_BYTES_UNSUPPORTED"));
});

describe("private media identity and key policy", () => {
  it("canonicalizes UUID case in both directions", () => {
    const lower = "123e4567-e89b-42d3-a456-426614174000";
    const upper = lower.toUpperCase();
    expect(canonicalMediaIdempotencyKey(lower)).toBe(lower);
    expect(canonicalMediaIdempotencyKey(upper)).toBe(lower);
    expect(canonicalMediaIdempotencyKey(canonicalMediaIdempotencyKey(upper))).toBe(lower);
  });

  it.each([
    undefined, "", "a".repeat(63), "a".repeat(65), "gg".repeat(32), "0".repeat(64),
    "a".repeat(64), "01".repeat(32), "0123456789abcdef".repeat(4),
    ...["change-me", "example", "test", "dummy", "placeholder"].map((marker) => Buffer.from(marker.padEnd(32, "x")).toString("hex")),
  ])("rejects malformed, repeated, zero and placeholder media secrets %#", (candidate) => {
    expect(() => parseMediaCapabilitySecret(candidate)).toThrow("MEDIA_CAPABILITY_SECRET_INVALID");
  });

  it("accepts exactly 32 bytes of non-placeholder hex in either case", () => {
    expect(parseMediaCapabilitySecret(secret)).toEqual(Buffer.from(secret, "hex"));
    expect(parseMediaCapabilitySecret(secret.toUpperCase())).toEqual(Buffer.from(secret, "hex"));
  });
});

describe("manual redaction", () => {
  it("copies, freezes and bounds every rectangle", () => {
    const input = [{ x: 1, y: 2, width: 3, height: 4 }];
    const result = validateRedactionRectangles(input, { width: 20, height: 20 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    input[0]!.x = 10;
    expect(result[0]!.x).toBe(1);
    expect(() => validateRedactionRectangles([{ x: 19, y: 0, width: 2, height: 2 }], { width: 20, height: 20 })).toThrow("MEDIA_REDACTION_INVALID");
  });
});
