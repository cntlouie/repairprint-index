import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET as getAdminQueue } from "@/app/api/admin/queue/route";
import { GET as getPrivateSubmissionEvidence } from "@/app/api/admin/submissions/[id]/evidence/route";
import { POST as createCatalogTarget } from "@/app/api/admin/catalog/targets/route";
import { GET as getSourceCandidates, POST as createSourceCandidate } from "@/app/api/admin/source-candidates/route";
import { GET as getSourcePolicies, POST as createSourcePolicy } from "@/app/api/admin/source-policies/route";

describe("admin API boundary", () => {
  it("rejects anonymous queue reads and applies private noindex headers", async () => {
    const response = await getAdminQueue(new NextRequest("http://localhost/api/admin/queue"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("rejects anonymous catalog draft writes before parsing or touching the database", async () => {
    const response = await createCatalogTarget(new NextRequest("http://localhost/api/admin/catalog/targets", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("keeps submitted evidence links behind reviewer MFA authorization", async () => {
    const response = await getPrivateSubmissionEvidence(
      new NextRequest("http://localhost/api/admin/submissions/private-id/evidence"),
      { params: Promise.resolve({ id: "private-id" }) },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it.each([
    ["candidate read", () => getSourceCandidates(new NextRequest("http://localhost/api/admin/source-candidates"))],
    ["candidate write", () => createSourceCandidate(new NextRequest("http://localhost/api/admin/source-candidates", { method: "POST" }))],
    ["policy read", () => getSourcePolicies(new NextRequest("http://localhost/api/admin/source-policies"))],
    ["policy write", () => createSourcePolicy(new NextRequest("http://localhost/api/admin/source-policies", { method: "POST" }))],
  ])("keeps private source %s behind staff authorization", async (_label, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });
});
