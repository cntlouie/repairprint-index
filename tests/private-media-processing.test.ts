import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { processPrivateMedia } from "@/lib/private-media-processing";

describe("private media byte processing", () => {
  it("decodes, strips metadata and creates bounded private WebP derivatives", async () => {
    const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "red" } })
      .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "PRIVATE_SENTINEL" } } }).toBuffer();
    const result = await processPrivateMedia(source, { bytes: source.length, extension: "jpg", mimeType: "image/jpeg" });
    const master = await sharp(result.master).metadata();
    expect([master.width, master.height]).toEqual([16, 32]);
    expect(master.exif).toBeUndefined();
    expect(Buffer.from(result.master).includes(Buffer.from("PRIVATE_SENTINEL"))).toBe(false);
    expect(result.thumbnail.length).toBeGreaterThan(0);
  });

  it("rejects MIME confusion, malformed data, animation and polyglot tails", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    await expect(processPrivateMedia(png, { bytes: png.length, extension: "jpg", mimeType: "image/jpeg" })).rejects.toThrow("MEDIA_TYPE_MISMATCH");
    const tailed = Buffer.concat([png, Buffer.from("<script>")]);
    await expect(processPrivateMedia(tailed, { bytes: tailed.length, extension: "png", mimeType: "image/png" })).rejects.toThrow("MEDIA_CONTAINER_INVALID");
    await expect(processPrivateMedia(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { bytes: 4, extension: "jpg", mimeType: "image/jpeg" })).rejects.toThrow("MEDIA_DECODE_FAILED");
    const frames = Buffer.alloc(4 * 8 * 3);
    for (let index = 0; index < 4 * 4 * 3; index += 1) frames[index] = index % 3 === 0 ? 255 : 0;
    for (let index = 4 * 4 * 3; index < frames.length; index += 1) frames[index] = index % 3 === 2 ? 255 : 0;
    const animated = await sharp(frames, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    await expect(processPrivateMedia(animated, { bytes: animated.length, extension: "webp", mimeType: "image/webp" })).rejects.toThrow("MEDIA_DIMENSIONS_INVALID");
    const tooWide = await sharp({ create: { width: 12001, height: 1, channels: 3, background: "black" } }).png().toBuffer();
    await expect(processPrivateMedia(tooWide, { bytes: tooWide.length, extension: "png", mimeType: "image/png" })).rejects.toThrow("MEDIA_DIMENSIONS_INVALID");
  });
});
