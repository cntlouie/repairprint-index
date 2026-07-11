import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET as getAdminQueue } from "@/app/api/admin/queue/route";
import { POST as createCatalogTarget } from "@/app/api/admin/catalog/targets/route";

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
});
