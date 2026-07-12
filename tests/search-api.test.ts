import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/search/route";

const previousDemoMode = process.env.DEMO_MODE;

describe("search API", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
  });

  afterEach(() => {
    if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousDemoMode;
  });

  it("returns the versioned cursor response contract", async () => {
    const response = await GET(new NextRequest("http://localhost/api/v1/search?q=DV-100&limit=1"));
    const body = await response.json() as { results: unknown[]; ambiguity: unknown; page: { nextCursor: string | null } };
    expect(response.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.ambiguity).toBeNull();
    expect(body.page).toHaveProperty("nextCursor");
  });

  it.each([
    ["q=x", "QUERY_TOO_SHORT"],
    ["q=DV-100&limit=0", "INVALID_LIMIT"],
    ["q=DV-100&limit=51", "INVALID_LIMIT"],
    ["q=DV-100&cursor=broken", "INVALID_CURSOR"],
  ])("rejects invalid input: %s", async (parameters, code) => {
    const response = await GET(new NextRequest(`http://localhost/api/v1/search?${parameters}`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: code });
  });
});
