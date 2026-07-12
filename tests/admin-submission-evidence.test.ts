import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getEvidence: vi.fn(),
}));

vi.mock("@/lib/admin-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-api")>();
  return { ...original, authorizeAdminRequest: mocks.authorize };
});
vi.mock("@/db/editorial", () => ({ getSubmissionEvidenceLink: mocks.getEvidence }));

import { GET } from "@/app/api/admin/submissions/[id]/evidence/route";

describe("private submitted-evidence endpoint", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({ id: "reviewer" });
    mocks.getEvidence.mockReset();
  });

  it("rejects malformed identifiers safely before database access", async () => {
    const response = await GET(
      new NextRequest("https://repairprint.example/api/admin/submissions/not-a-uuid/evidence"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INPUT_INVALID", field: "" },
    });
    expect(mocks.getEvidence).not.toHaveBeenCalled();
  });
});
