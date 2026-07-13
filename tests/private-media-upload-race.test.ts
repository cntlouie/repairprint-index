import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), mark: vi.fn(), readBody: vi.fn(), remove: vi.fn(), requireCapability: vi.fn(), upload: vi.fn(),
}));

vi.mock("@/db/private-media", () => ({ findPrivateMediaSession: mocks.find, markPrivateMediaUploaded: mocks.mark }));
vi.mock("@/db/submission-client", () => ({ getSubmissionDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/private-media-config", () => ({ resolvePrivateMediaConfig: () => ({
  capabilitySecret: "ae6d906fb88b298403ce80c7d2ca02c7cc39f8b3701270a8b01bf3c51bfd368f",
  privateBucket: "private", privacyVersion: "privacy", quarantineBucket: "quarantine", retentionDays: 30,
  retentionVersion: "retention", termsVersion: "terms",
}) }));
vi.mock("@/lib/private-media-storage", () => ({ createPrivateMediaStorage: () => ({
  download: vi.fn(), remove: mocks.remove, upload: mocks.upload,
}) }));
vi.mock("@/lib/private-media-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/private-media-api")>();
  return { ...original, readBoundedMediaBody: mocks.readBody, requireMediaCapability: mocks.requireCapability };
});

import { PUT } from "@/app/api/v1/private-media/[mediaId]/upload/route";

const mediaId = "media_0123456789abcdefghijklmnop";
const issued = Object.freeze({
  claimedBytes: 4, claimedExtension: "jpg", claimedMimeType: "image/jpeg", cleanupActive: false,
  finalizeCapabilityExpiresAt: null, id: "10000000-0000-4000-8000-000000000001",
  intakeId: "10000000-0000-4000-8000-000000000002", publicId: mediaId,
  quarantineObjectPath: "quarantine/ab/abcdefghijklmnopqrstuvwx", status: "issued",
});

describe("private media upload versus cleanup", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    mocks.find.mockReset(); mocks.mark.mockReset(); mocks.readBody.mockReset().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
    mocks.remove.mockReset().mockResolvedValue(undefined); mocks.requireCapability.mockReset().mockReturnValue({ nonce: "nonce" });
    mocks.upload.mockReset().mockResolvedValue(undefined);
  });

  it("removes the just-written object if cleanup completed and deleted the session before the state transition", async () => {
    mocks.find.mockResolvedValueOnce(issued).mockResolvedValueOnce(null);
    mocks.mark.mockRejectedValue(new Error("MEDIA_UPLOAD_NOT_AVAILABLE"));
    const response = await PUT(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/upload`, { method: "PUT" }), { params: Promise.resolve({ mediaId }) });
    expect(response.status).toBe(400);
    expect(mocks.remove).toHaveBeenCalledWith("quarantine", [issued.quarantineObjectPath]);
  });

  it("does not remove an object retained by a concurrent successful upload", async () => {
    mocks.find.mockResolvedValueOnce(issued).mockResolvedValueOnce({ ...issued, status: "uploaded" });
    mocks.mark.mockRejectedValue(new Error("MEDIA_UPLOAD_NOT_AVAILABLE"));
    await PUT(new NextRequest(`https://repairprint.example/api/v1/private-media/${mediaId}/upload`, { method: "PUT" }), { params: Promise.resolve({ mediaId }) });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
