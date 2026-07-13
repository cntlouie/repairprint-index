import { createHmac, timingSafeEqual } from "node:crypto";

export const PRIVATE_MEDIA_PURPOSES = ["model_label", "installed_fit", "broken_part_context"] as const;
export type PrivateMediaPurpose = (typeof PRIVATE_MEDIA_PURPOSES)[number];

export const PRIVATE_MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export type PrivateMediaMimeType = (typeof PRIVATE_MEDIA_MIME_TYPES)[number];

export const PRIVATE_MEDIA_LIMITS = Object.freeze({
  capabilitySeconds: 300,
  maxBytes: 10 * 1024 * 1024,
  maxCountPerIntake: 3,
  maxDimension: 12_000,
  maxPixels: 40_000_000,
  quarantineSeconds: 30 * 60,
  thumbnailPixels: 640,
});

export type MediaConsent = Readonly<{
  derivativeProcessing: true;
  ownsOrHasPermission: true;
  privateStorage: true;
  publicDisplay: boolean;
  acceptedAt: Date;
  retentionDeadline: Date;
  privacyVersion: string;
  retentionVersion: string;
  termsVersion: string;
}>;

export type MediaCapabilityClaims = Readonly<{
  expiresAt: number;
  issuedAt: number;
  mediaPublicId: string;
  nonce: string;
  operation: "upload" | "finalize";
}>;

export type MediaRectangle = Readonly<{ height: number; width: number; x: number; y: number }>;

export function assertPrivateMediaPurpose(value: string): asserts value is PrivateMediaPurpose {
  if (!(PRIVATE_MEDIA_PURPOSES as readonly string[]).includes(value)) throw new Error("MEDIA_PURPOSE_INVALID");
}

export function assertMediaConsent(consent: MediaConsent, now: Date): void {
  if (!consent.ownsOrHasPermission || !consent.privateStorage || !consent.derivativeProcessing) {
    throw new Error("MEDIA_CONSENT_REQUIRED");
  }
  if (![consent.termsVersion, consent.privacyVersion, consent.retentionVersion].every(validVersion)) {
    throw new Error("MEDIA_POLICY_VERSION_REQUIRED");
  }
  if (!(consent.acceptedAt <= now) || !(consent.retentionDeadline > consent.acceptedAt)) {
    throw new Error("MEDIA_RETENTION_INVALID");
  }
}

export function signMediaCapability(claims: MediaCapabilityClaims, secret: string): string {
  assertCapabilityClaims(claims);
  assertSecret(secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyMediaCapability(
  token: string,
  expected: Readonly<{ mediaPublicId: string; operation: MediaCapabilityClaims["operation"] }>,
  secret: string,
  now: Date,
): MediaCapabilityClaims {
  assertSecret(secret);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("MEDIA_CAPABILITY_INVALID");
  const calculated = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { throw new Error("MEDIA_CAPABILITY_INVALID"); }
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) {
    throw new Error("MEDIA_CAPABILITY_INVALID");
  }
  let claims: MediaCapabilityClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MediaCapabilityClaims; }
  catch { throw new Error("MEDIA_CAPABILITY_INVALID"); }
  assertCapabilityClaims(claims);
  if (claims.mediaPublicId !== expected.mediaPublicId || claims.operation !== expected.operation) {
    throw new Error("MEDIA_CAPABILITY_SCOPE_INVALID");
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.expiresAt <= nowSeconds || claims.issuedAt > nowSeconds + 30) throw new Error("MEDIA_CAPABILITY_EXPIRED");
  if (claims.expiresAt - claims.issuedAt > PRIVATE_MEDIA_LIMITS.capabilitySeconds) {
    throw new Error("MEDIA_CAPABILITY_INVALID");
  }
  return Object.freeze({ ...claims });
}

export function validateRedactionRectangles(
  rectangles: readonly MediaRectangle[],
  image: Readonly<{ height: number; width: number }>,
): readonly MediaRectangle[] {
  if (rectangles.length < 1 || rectangles.length > 32) throw new Error("MEDIA_REDACTION_INVALID");
  const checked = rectangles.map((rectangle) => {
    for (const value of [rectangle.x, rectangle.y, rectangle.width, rectangle.height]) {
      if (!Number.isSafeInteger(value)) throw new Error("MEDIA_REDACTION_INVALID");
    }
    if (rectangle.x < 0 || rectangle.y < 0 || rectangle.width < 1 || rectangle.height < 1
      || rectangle.x + rectangle.width > image.width || rectangle.y + rectangle.height > image.height) {
      throw new Error("MEDIA_REDACTION_INVALID");
    }
    return Object.freeze({ ...rectangle });
  });
  return Object.freeze(checked);
}

export function detectPrivateMediaType(bytes: Uint8Array): PrivateMediaMimeType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "image/avif";
  throw new Error("MEDIA_BYTES_UNSUPPORTED");
}

export function assertExactContainer(bytes: Uint8Array, mime: PrivateMediaMimeType): void {
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("MEDIA_CONTAINER_INVALID");
    return;
  }
  if (mime === "image/png") {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readU32(bytes, offset);
      const end = offset + 12 + length;
      if (end > bytes.length) break;
      const type = ascii(bytes, offset + 4, offset + 8);
      offset = end;
      if (type === "IEND") {
        if (length !== 0 || offset !== bytes.length) throw new Error("MEDIA_CONTAINER_INVALID");
        return;
      }
    }
    throw new Error("MEDIA_CONTAINER_INVALID");
  }
  if (mime === "image/webp") {
    if (readU32LE(bytes, 4) + 8 !== bytes.length) throw new Error("MEDIA_CONTAINER_INVALID");
    return;
  }
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = readU32(bytes, offset);
    if (size < 8 || offset + size > bytes.length) throw new Error("MEDIA_CONTAINER_INVALID");
    offset += size;
  }
  if (offset !== bytes.length) throw new Error("MEDIA_CONTAINER_INVALID");
}

function assertCapabilityClaims(value: MediaCapabilityClaims): void {
  if (!value || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || !/^[A-Za-z0-9_-]{22,128}$/.test(value.mediaPublicId)
    || !/^[A-Za-z0-9_-]{22,128}$/.test(value.nonce)
    || !["upload", "finalize"].includes(value.operation)
    || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > PRIVATE_MEDIA_LIMITS.capabilitySeconds) {
    throw new Error("MEDIA_CAPABILITY_INVALID");
  }
}

function assertSecret(value: string): void {
  if (!/^[0-9a-f]{64,}$/i.test(value)) throw new Error("MEDIA_CAPABILITY_SECRET_INVALID");
}

function validVersion(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(value); }
function ascii(bytes: Uint8Array, start: number, end: number): string { return Buffer.from(bytes.subarray(start, end)).toString("ascii"); }
function readU32(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); }
function readU32LE(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
