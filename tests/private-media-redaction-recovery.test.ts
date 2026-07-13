import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), download: vi.fn(), get: vi.fn(), record: vi.fn(), redact: vi.fn(),
  remove: vi.fn(), reserve: vi.fn(), upload: vi.fn(),
}));

vi.mock("@/lib/admin-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-api")>();
  return { ...original, authorizeAdminRequest: mocks.authorize };
});
vi.mock("@/db/private-media-review", () => ({
  getPrivateReviewMedia: mocks.get,
  recordPrivateMediaRedaction: mocks.record,
  reservePrivateMediaRedactionObject: mocks.reserve,
}));
vi.mock("@/lib/private-media-config", () => ({ resolvePrivateMediaConfig: () => ({ privateBucket: "private" }) }));
vi.mock("@/lib/private-media-processing", () => ({
  mediaChecksum: () => "a".repeat(64),
  redactPrivateMedia: mocks.redact,
}));
vi.mock("@/lib/private-media-storage", () => ({ createPrivateMediaStorage: () => ({
  download: mocks.download, remove: mocks.remove, upload: mocks.upload,
}) }));

import { POST } from "@/app/api/admin/media/[id]/redact/route";

const assetId = "10000000-0000-4000-8000-000000000001";

describe("private media redaction crash recovery", () => {
  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).webp().toBuffer();
    mocks.authorize.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000002" });
    mocks.get.mockResolvedValue({ assetId, height: 8, objectPath: `private/aa/media_0123456789abcdefghijklmnop/master-${"b".repeat(64)}.webp`, width: 8 });
    mocks.download.mockResolvedValue(image);
    mocks.redact.mockResolvedValue(image);
    mocks.reserve.mockResolvedValue(undefined);
    mocks.upload.mockResolvedValue(undefined);
  });

  it("keeps the pre-upload manifest when database recording and compensation deletion both fail", async () => {
    mocks.record.mockRejectedValue(new Error("PRIVATE_MEDIA_NOT_FOUND"));
    mocks.remove.mockRejectedValue(new Error("storage unavailable"));
    const response = await POST(new NextRequest(`https://repairprint.example/api/admin/media/${assetId}/redact`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Remove private serial label", rectangles: [{ x: 0, y: 0, width: 2, height: 2 }] }),
    }), { params: Promise.resolve({ id: assetId }) });
    expect(response.status).toBe(400);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.upload.mock.invocationCallOrder[0]!);
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(mocks.record.mock.invocationCallOrder[0]!);
    expect(mocks.remove).toHaveBeenCalledWith("private", [expect.stringContaining("/redacted-")]);
    expect(mocks.reserve).toHaveBeenCalledOnce();
  });
});
