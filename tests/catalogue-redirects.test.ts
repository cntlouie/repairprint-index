import { describe, expect, it } from "vitest";

import { resolveRedirectChain, type SlugRedirectRecord } from "@/domain/catalogue";

const oldPath = "/parts/old-part";

function redirectTo(replacementPath: string): SlugRedirectRecord[] {
  return [{ oldPath, replacementPath }];
}

describe("catalogue slug-history redirect hardening", () => {
  it("resolves a valid historical chain once to its canonical part route", () => {
    expect(resolveRedirectChain([
      { oldPath, replacementPath: "/parts/intermediate-part" },
      { oldPath: "/parts/intermediate-part", replacementPath: "/parts/canonical-part" },
    ], oldPath)).toBe("/parts/canonical-part");
  });

  it("accepts the same safe route shape for an approved tombstone destination", () => {
    expect(resolveRedirectChain(redirectTo("/parts/removed-source-part"), oldPath))
      .toBe("/parts/removed-source-part");
  });

  it("normalizes harmless encoded ASCII slug characters", () => {
    expect(resolveRedirectChain(redirectTo("/parts/canonical%2Dpart"), oldPath))
      .toBe("/parts/canonical-part");
  });

  it.each([
    "https://evil.invalid/x",
    "//evil.invalid/x",
    "/%2F%2Fevil.invalid/x",
    "/%2f%2fevil.invalid/x",
    "/%252F%252Fevil.invalid/x",
    "/%252f%252fevil.invalid/x",
    "/parts/foo%2Fbar",
    "/parts/foo%2fbar",
    "/parts/foo%252Fbar",
    "/parts/foo%252fbar",
    "/parts/%2e%2e/admin",
    "/parts/%2E%2e/admin",
    "/parts/%252e%252e/admin",
    "/parts/%252E%252e/admin",
    "/parts/safe%2F..%2Fadmin",
    "/parts/safe%252f..%252fadmin",
    "/parts/../admin",
    "/parts/foo%5cbar",
    "/parts/foo%5Cbar",
    "/parts/foo%255cbar",
    "/parts/foo%255Cbar",
    "/parts/foo\\bar",
    "/parts/canonical-part?next=/admin",
    "/parts/canonical-part#fragment",
    "/parts/canonical-part%3fnext=/admin",
    "/parts/canonical-part%23fragment",
    "/parts/canonical-part%00",
    "/parts/canonical-part%0d%0aheader",
    "/parts/canonical-part\u0000",
    "/parts/canonical-part\u001f",
    "/parts/canonical-part\u007f",
    "/parts/%",
    "/parts/%2",
    "/parts/%GG",
    "/parts/%c0%af",
    "/parts/canonical%252Dpart",
    "/parts/UPPERCASE",
    "/parts/two--hyphens",
    "/parts/trailing-slash/",
    "/parts/non-ascii-é",
    "/brands/demo/model",
  ])("rejects an unsafe or non-canonical destination: %s", (replacementPath) => {
    expect(resolveRedirectChain(redirectTo(replacementPath), oldPath)).toBeNull();
  });

  it("rejects unsafe initial paths before consulting history", () => {
    expect(resolveRedirectChain([
      { oldPath: "/parts/%2e%2e/admin", replacementPath: "/parts/canonical-part" },
    ], "/parts/%2e%2e/admin")).toBeNull();
  });

  it("fails closed for self-loops, cycles and ambiguous normalized sources", () => {
    expect(resolveRedirectChain(redirectTo(oldPath), oldPath)).toBeNull();

    expect(resolveRedirectChain([
      { oldPath, replacementPath: "/parts/second-part" },
      { oldPath: "/parts/second-part", replacementPath: oldPath },
    ], oldPath)).toBeNull();

    expect(resolveRedirectChain([
      { oldPath: "/parts/old%2Dpart", replacementPath: "/parts/first-part" },
      { oldPath, replacementPath: "/parts/second-part" },
    ], oldPath)).toBeNull();
  });

  it("fails closed when the maximum redirect depth is reached", () => {
    expect(resolveRedirectChain([
      { oldPath, replacementPath: "/parts/second-part" },
      { oldPath: "/parts/second-part", replacementPath: "/parts/canonical-part" },
    ], oldPath, 1)).toBeNull();
  });
});
