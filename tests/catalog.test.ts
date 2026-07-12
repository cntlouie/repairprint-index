import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveRedirectChain } from "@/domain/catalogue";
import { catalogTagsForContext } from "@/lib/catalog-cache";
import { getModel, getPart, listModels, listRecentParts } from "@/lib/catalog";

const originalDemoMode = process.env.DEMO_MODE;

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("production public catalogue boundary", () => {
  it("keeps fictional catalogue records in explicit test fixtures only", () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "src/lib/demo-data.ts"))).toBe(false);
    expect(existsSync(path.join(root, "tests/fixtures/demo-catalogue.ts"))).toBe(true);
    expect(readFileSync(path.join(root, "src/lib/catalog.ts"), "utf8")).not.toContain("demo-data");
  });

  it("locks the SQL publication boundary to current, sourced, low-risk non-demo records", () => {
    const migration = readFileSync(path.join(process.cwd(), "drizzle/0005_production_public_catalogue.sql"), "utf8");
    for (const invariant of [
      "fitment.publication_status = 'published'",
      "fitment.confidence_version = 'fitment-v1'",
      "source.source_type <> 'demo'",
      "source.status = 'live'",
      "policy.policy <> 'blocked'",
      "product_component.mapping_status = 'accepted'",
      "safety.safety_class = 'low'",
      "safety.ruleset_version = 'safety-v1'",
      "notice.kind = 'rights_or_safety_notice'",
      "evidence.outcome = 'does_not_fit'",
    ]) expect(migration).toContain(invariant);
  });

  it("returns no static catalogue records while demo mode blocks production queries", async () => {
    process.env.DEMO_MODE = "true";
    await expect(listModels()).resolves.toEqual([]);
    await expect(listRecentParts()).resolves.toEqual([]);
    await expect(getModel("demovac", "dv-100")).resolves.toBeNull();
    await expect(getPart("demovac-dv-100-dust-bin-latch")).resolves.toEqual({ kind: "not_found" });
  });

  it("resolves a historical chain once to its final canonical path", () => {
    expect(resolveRedirectChain([
      { oldPath: "/parts/old", replacementPath: "/parts/intermediate" },
      { oldPath: "/parts/intermediate", replacementPath: "/parts/canonical" },
    ], "/parts/old")).toBe("/parts/canonical");
  });

  it.each([
    [[{ oldPath: "/parts/a", replacementPath: "/parts/a" }], "/parts/a"],
    [[
      { oldPath: "/parts/a", replacementPath: "/parts/b" },
      { oldPath: "/parts/b", replacementPath: "/parts/a" },
    ], "/parts/a"],
    [[{ oldPath: "/parts/a", replacementPath: "https://example.invalid" }], "/parts/a"],
  ] as const)("fails closed for unsafe or looping redirects", (records, initialPath) => {
    expect(resolveRedirectChain(records, initialPath)).toBeNull();
  });

  it("invalidates index, exact-model and every grouped part tag", () => {
    expect(catalogTagsForContext({
      modelPaths: [
        { brandSlug: "brand-a", modelSlug: "model-one" },
        { brandSlug: "brand-a", modelSlug: "model-two" },
      ],
      partSlugs: ["part-one", "part-two", "part-one"],
    })).toEqual([
      "catalogue:all",
      "catalogue:index",
      "catalogue:model:brand-a:model-one",
      "catalogue:model:brand-a:model-two",
      "catalogue:part:part-one",
      "catalogue:part:part-two",
    ]);
  });
});
