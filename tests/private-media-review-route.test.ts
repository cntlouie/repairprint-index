import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn() }));

vi.mock("@/lib/admin-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/admin-api")>();
  return { ...original, authorizeAdminRequest: mocks.authorize };
});
vi.mock("@/db/private-media-review", () => ({ listPrivateReviewMedia: mocks.list }));

import { GET } from "@/app/api/admin/submissions/[id]/media/route";

const submissionId = "10000000-0000-4000-8000-000000000001";
const intakeId = "10000000-0000-4000-8000-000000000002";

describe("AAL2 private-media intake discovery", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000003" });
    mocks.list.mockReset().mockResolvedValue(Object.freeze([]));
  });

  it("authorizes evidence review and binds discovery to both submission and exact intake", async () => {
    const request = new NextRequest(`https://repairprint.example/api/admin/submissions/${submissionId}/media?intakeId=${intakeId}`, {
      headers: { authorization: "Bearer staff", "x-request-id": "req_media_discovery" },
    });
    const response = await GET(request, { params: Promise.resolve({ id: submissionId }) });
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(request, "evidence:review");
    expect(mocks.list).toHaveBeenCalledWith({
      actorId: "10000000-0000-4000-8000-000000000003", intakeId,
      requestId: "req_media_discovery", submissionId,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects missing or malformed intake identifiers before discovery", async () => {
    const response = await GET(
      new NextRequest(`https://repairprint.example/api/admin/submissions/${submissionId}/media`, { headers: { authorization: "Bearer staff" } }),
      { params: Promise.resolve({ id: submissionId }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
