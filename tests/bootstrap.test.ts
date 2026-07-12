import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";
import { metadata as adminMetadata } from "@/app/admin/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const originalDemoMode = process.env.DEMO_MODE;
const root = process.cwd();

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("WP-00 demo crawler lock", () => {
  it.each([undefined, "true", "TRUE", "1"])("fails closed when DEMO_MODE is %s", async (value) => {
    if (value === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = value;

    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    await expect(sitemap()).resolves.toEqual([]);
  });

  it("adds a page-level noindex directive to demo builds", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true });
  });

  it("keeps the authenticated admin workspace out of indexes in every mode", () => {
    expect(adminMetadata.robots).toEqual({ index: false, follow: false, nocache: true });
  });

  it("lets an invited staff session establish its password before sign-out", () => {
    const adminWorkspace = readFileSync(path.join(root, "src/components/AdminWorkspace.tsx"), "utf8");
    expect(adminWorkspace).toContain("Set or change password");
    expect(adminWorkspace).toContain("supabase.auth.updateUser({ password: newPassword })");
    expect(adminWorkspace).toContain("minLength={12}");
    expect(adminWorkspace).toContain('flowType: "implicit"');
    expect(adminWorkspace).toContain("detectSessionInUrl: true");
    expect(adminWorkspace).toContain('event === "PASSWORD_RECOVERY"');
    expect(adminWorkspace).toContain("window.history.replaceState");
  });
});
