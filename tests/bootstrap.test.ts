import { afterEach, describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";
import { metadata as adminMetadata } from "@/app/admin/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const originalDemoMode = process.env.DEMO_MODE;

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("WP-00 demo crawler lock", () => {
  it.each([undefined, "true", "TRUE", "1"])("fails closed when DEMO_MODE is %s", (value) => {
    if (value === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = value;

    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    expect(sitemap()).toEqual([]);
  });

  it("adds a page-level noindex directive to demo builds", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true });
  });

  it("keeps the authenticated admin workspace out of indexes in every mode", () => {
    expect(adminMetadata.robots).toEqual({ index: false, follow: false, nocache: true });
  });
});
