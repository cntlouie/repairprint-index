import { describe, expect, it } from "vitest";
import { normalizeIdentifier, normalizeSearchQuery, slugify } from "@/domain/normalization";

describe("identifier normalization", () => {
  it("preserves meaningful leading zeros", () => {
    expect(normalizeIdentifier(" 006-11475 ")).toBe("00611475");
  });

  it("normalizes regional suffix punctuation without inventing equivalence", () => {
    expect(normalizeIdentifier("sms46mi05e/01")).toBe("SMS46MI05E01");
    expect(normalizeIdentifier("sms46mi05e/02")).not.toBe(normalizeIdentifier("sms46mi05e/01"));
  });

  it("collapses query whitespace", () => {
    expect(normalizeSearchQuery("  dust   bin latch ")).toBe("dust bin latch");
  });

  it("creates stable ASCII slugs", () => {
    expect(slugify("Upper-rack wheel / clip")).toBe("upper-rack-wheel-clip");
  });
});
