import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";

import { assertExactContainer, detectPrivateMediaType, PRIVATE_MEDIA_LIMITS, type PrivateMediaMimeType } from "@/domain/private-media";

export type ProcessedPrivateMedia = Readonly<{
  detectedMimeType: PrivateMediaMimeType;
  height: number;
  master: Uint8Array;
  masterChecksum: string;
  sourceChecksum: string;
  thumbnail: Uint8Array;
  thumbnailChecksum: string;
  width: number;
}>;

export async function processPrivateMedia(
  source: Uint8Array,
  claimed: Readonly<{ bytes: number; extension: string; mimeType: string }>,
): Promise<ProcessedPrivateMedia> {
  if (source.length < 1 || source.length > PRIVATE_MEDIA_LIMITS.maxBytes || source.length !== claimed.bytes) throw new Error("MEDIA_SIZE_INVALID");
  const detectedMimeType = detectPrivateMediaType(source);
  if (detectedMimeType !== claimed.mimeType || extensionMime(claimed.extension) !== detectedMimeType) throw new Error("MEDIA_TYPE_MISMATCH");
  assertExactContainer(source, detectedMimeType);
  let metadata: Metadata;
  try {
    metadata = await sharp(source, { animated: true, failOn: "warning", limitInputPixels: PRIVATE_MEDIA_LIMITS.maxPixels }).metadata();
  } catch { throw new Error("MEDIA_DECODE_FAILED"); }
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1
    || metadata.width > PRIVATE_MEDIA_LIMITS.maxDimension || metadata.height > PRIVATE_MEDIA_LIMITS.maxDimension
    || metadata.width * metadata.height > PRIVATE_MEDIA_LIMITS.maxPixels) throw new Error("MEDIA_DIMENSIONS_INVALID");
  try {
    const oriented = sharp(source, { animated: false, failOn: "warning", limitInputPixels: PRIVATE_MEDIA_LIMITS.maxPixels }).rotate();
    const master = await oriented.clone().webp({ quality: 88, effort: 4 }).toBuffer();
    const thumbnail = await oriented.clone().resize({ width: PRIVATE_MEDIA_LIMITS.thumbnailPixels, height: PRIVATE_MEDIA_LIMITS.thumbnailPixels, fit: "inside", withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer();
    const normalized = await sharp(master).metadata();
    return Object.freeze({
      detectedMimeType,
      height: normalized.height!,
      master: new Uint8Array(master),
      masterChecksum: hash(master),
      sourceChecksum: hash(source),
      thumbnail: new Uint8Array(thumbnail),
      thumbnailChecksum: hash(thumbnail),
      width: normalized.width!,
    });
  } catch { throw new Error("MEDIA_PROCESSING_FAILED"); }
}

export async function redactPrivateMedia(source: Uint8Array, rectangles: readonly Readonly<{ x: number; y: number; width: number; height: number }>[]): Promise<Uint8Array> {
  const overlays = rectangles.map((region) => ({ input: { create: { width: region.width, height: region.height, channels: 4 as const, background: "#111111" } }, left: region.x, top: region.y }));
  return new Uint8Array(await sharp(source, { failOn: "warning", limitInputPixels: PRIVATE_MEDIA_LIMITS.maxPixels }).composite(overlays).webp({ quality: 88, effort: 4 }).toBuffer());
}

function extensionMime(extension: string): string {
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" } as Record<string, string>)[extension.toLowerCase()] ?? "";
}
export function mediaChecksum(bytes: Uint8Array): string { return hash(bytes); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
