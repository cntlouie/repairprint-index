import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), confirmDeleted: vi.fn(), download: vi.fn(),
  markPending: vi.fn(), process: vi.fn(), reject: vi.fn(), remove: vi.fn(), requireCapability: vi.fn(), reserve: vi.fn(), upload: vi.fn(),
}));

vi.mock("@/db/private-media", () => ({
  claimPrivateMediaProcessing: mocks.claim,
  completePrivateMediaProcessing: mocks.complete,
  confirmPrivateMediaQuarantineDeleted: mocks.confirmDeleted,
  markPrivateMediaQuarantineCleanupPending: mocks.markPending,
  rejectPrivateMediaProcessing: mocks.reject,
  reservePrivateMediaProcessingObjects: mocks.reserve,
}));
vi.mock("@/db/submission-client", () => ({ getSubmissionDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/private-media-config", () => ({ resolvePrivateMediaConfig: () => ({
  capabilitySecret: "ae6d906fb88b298403ce80c7d2ca02c7cc39f8b3701270a8b01bf3c51bfd368f",
  privateBucket: "private", privacyVersion: "privacy", quarantineBucket: "quarantine", retentionDays: 30,
  retentionVersion: "retention", termsVersion: "terms",
}) }));
vi.mock("@/lib/private-media-storage", () => ({ createPrivateMediaStorage: () => ({
  download: mocks.download, remove: mocks.remove, upload: mocks.upload,
}) }));
vi.mock("@/lib/private-media-processing", () => ({
  mediaChecksum: vi.fn(), processPrivateMedia: mocks.process,
}));
vi.mock("@/lib/private-media-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/private-media-api")>();
  return { ...original, requireMediaCapability: mocks.requireCapability };
});

import { POST } from "@/app/api/v1/private-media/[mediaId]/finalize/route";

const mediaId = "media_0123456789abcdefghijklmnop";
const session = Object.freeze({
  claimedBytes: 4, claimedExtension: "jpg", claimedMimeType: "image/jpeg", cleanupActive: false,
  finalizeCapabilityExpiresAt: new Date(Date.now() + 60_000), id: "10000000-0000-4000-8000-000000000001",
  intakeId: "10000000-0000-4000-8000-000000000002", leaseToken: "10000000-0000-4000-8000-000000000003",
  publicId: mediaId, quarantineObjectPath: "quarantine/ab/abcdefghijklmnopqrstuvwx",
  retentionDeadline: new Date(Date.now() + 86_400_000), status: "processing",
});

describe("private media terminal quarantine recovery", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.claim.mockResolvedValue(session);
    mocks.download.mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
    mocks.process.mockRejectedValue(new Error("MEDIA_TYPE_MISMATCH"));
    mocks.reject.mockResolvedValue(undefined);
    mocks.reserve.mockResolvedValue(undefined);
    mocks.confirmDeleted.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.requireCapability.mockReturnValue({ nonce: "nonce" });
  });

  it("durably marks rejection before deletion and leaves it pending when storage deletion fails", async () => {
    mocks.remove.mockRejectedValue(new Error("storage unavailable"));
    const response = await POST(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/finalize`, { method: "POST" }), { params: Promise.resolve({ mediaId }) });
    expect(response.status).toBe(400);
    expect(mocks.reject).toHaveBeenCalledWith(session.id, session.leaseToken, "MEDIA_TYPE_MISMATCH", {});
    expect(mocks.reject.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!);
    expect(mocks.confirmDeleted).not.toHaveBeenCalled();
  });

  it("clears the durable pending marker only after deletion succeeds", async () => {
    await POST(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/finalize`, { method: "POST" }), { params: Promise.resolve({ mediaId }) });
    expect(mocks.remove).toHaveBeenCalledWith("quarantine", [session.quarantineObjectPath]);
    expect(mocks.confirmDeleted).toHaveBeenCalledWith(session.id, {});
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirmDeleted.mock.invocationCallOrder[0]!);
  });

  it("commits processing with durable quarantine cleanup before attempting quarantine deletion", async () => {
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).webp().toBuffer();
    mocks.process.mockResolvedValue({
      detectedMimeType: "image/jpeg", height: 2, master: image, masterChecksum: "a".repeat(64),
      sourceChecksum: "b".repeat(64), thumbnail: image, thumbnailChecksum: "c".repeat(64), width: 2,
    });
    mocks.upload.mockResolvedValue(undefined);
    mocks.complete.mockResolvedValue("10000000-0000-4000-8000-000000000004");
    mocks.remove.mockImplementation((bucket: string) => bucket === "quarantine"
      ? Promise.reject(new Error("termination boundary")) : Promise.resolve());
    await POST(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/finalize`, { method: "POST" }), { params: Promise.resolve({ mediaId }) });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    const quarantineAttempt = mocks.remove.mock.calls.findIndex(([bucket]) => bucket === "quarantine");
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[quarantineAttempt]!);
    expect(mocks.confirmDeleted).not.toHaveBeenCalled();
  });

  it("leaves a durable manifest when a derivative upload succeeds but database commitment never occurs", async () => {
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).webp().toBuffer();
    mocks.process.mockResolvedValue({
      detectedMimeType: "image/jpeg", height: 2, master: image, masterChecksum: "d".repeat(64),
      sourceChecksum: "e".repeat(64), thumbnail: image, thumbnailChecksum: "f".repeat(64), width: 2,
    });
    mocks.upload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("thumbnail upload terminated"));
    mocks.remove.mockRejectedValue(new Error("compensation unavailable"));
    await POST(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/finalize`, { method: "POST" }), { params: Promise.resolve({ mediaId }) });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.upload.mock.invocationCallOrder[0]!);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith("private", [expect.stringContaining("/master-")]);
  });
});
