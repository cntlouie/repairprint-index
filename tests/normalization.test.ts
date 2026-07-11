import { describe, expect, it } from "vitest";
import {
  looseIdentifierKey,
  normalizeIdentifier,
  normalizeSearchQuery,
  resolveIdentifierWithinBrand,
  slugify,
  strictIdentifierKey,
} from "@/domain/normalization";

describe("identifier normalization", () => {
  it("preserves meaningful leading zeros", () => {
    expect(normalizeIdentifier(" 006-11475 ")).toBe("00611475");
  });

  it("normalizes regional suffix punctuation without inventing equivalence", () => {
    expect(normalizeIdentifier("sms46mi05e/01")).toBe("SMS46MI05E01");
    expect(normalizeIdentifier("sms46mi05e/02")).not.toBe(normalizeIdentifier("sms46mi05e/01"));
  });

  it("keeps strict suffix punctuation while loose keys remain search-only", () => {
    expect(strictIdentifierKey("sms46mi05e/01")).toBe("SMS46MI05E/01");
    expect(strictIdentifierKey("sms46mi05e-01")).toBe("SMS46MI05E-01");
    expect(looseIdentifierKey("sms46mi05e/01")).toBe(looseIdentifierKey("sms46mi05e-01"));
  });

  it("returns MODEL_AMBIGUOUS for a within-brand loose collision", () => {
    const result = resolveIdentifierWithinBrand("VC-01", "demo-brand", [
      { entityId: "model-a", brandKey: "demo-brand", displayValue: "VC/01" },
      { entityId: "model-b", brandKey: "demo-brand", displayValue: "VC 01" },
      { entityId: "other-brand", brandKey: "other", displayValue: "VC-01" },
    ]);

    expect(result).toEqual({
      kind: "ambiguous",
      entityIds: ["model-a", "model-b"],
      errorCodes: ["FIT-001"],
    });
  });

  it("resolves a strict match before considering a loose collision", () => {
    expect(resolveIdentifierWithinBrand("VC/01", "demo-brand", [
      { entityId: "model-a", brandKey: "demo-brand", displayValue: "VC/01" },
      { entityId: "model-b", brandKey: "demo-brand", displayValue: "VC-01" },
    ])).toEqual({ kind: "strict_exact", entityId: "model-a", errorCodes: [] });
  });

  it("collapses query whitespace", () => {
    expect(normalizeSearchQuery("  dust   bin latch ")).toBe("dust bin latch");
  });

  it("creates stable ASCII slugs", () => {
    expect(slugify("Upper-rack wheel / clip")).toBe("upper-rack-wheel-clip");
  });
});
