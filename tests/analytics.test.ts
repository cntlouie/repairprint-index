import { describe, expect, it } from "vitest";

import {
  analyticsDimensions,
  analyticsEventSchema,
  browserAnalyticsEventSchema,
  classifyDesignSourcePlatform,
  classifySearchForAnalytics,
  type AnalyticsEvent,
} from "@/domain/analytics";

const validEvents: readonly AnalyticsEvent[] = [
  { name: "search_submitted", properties: { normalizedCategory: "identifier", queryLength: 6, identifierLike: true } },
  { name: "search_resolved", properties: { entityType: "model", matchClass: "strict_identifier", rank: 1, ambiguityCount: 0 } },
  { name: "variant_disambiguation_shown", properties: { candidateCount: 2 } },
  { name: "variant_selected", properties: { selectedRank: 2 } },
  { name: "zero_result", properties: { tokenClass: "alphanumeric", brand: "demo-vac", category: "vacuum-cleaners" } },
  { name: "part_viewed", properties: { publicId: "fit_public_1", confidenceTier: "verified_fit", safetyClass: "low" } },
  { name: "original_source_clicked", properties: { publicId: "fit_public_1", sourcePlatform: "example.invalid", confidenceTier: "creator_listed" } },
  { name: "fit_report_started", properties: { publicId: "fit_public_1" } },
  { name: "fit_report_submitted", properties: { publicId: "fit_public_1", outcome: "print_failed" } },
  { name: "missing_part_submitted", properties: { categoryMatch: "matched", category: "vacuum-cleaners" } },
  { name: "design_submitted", properties: { sourcePlatform: "printables" } },
];

describe("analytics event contract", () => {
  it.each(validEvents)("accepts the strict $name event", (event) => {
    expect(analyticsEventSchema.parse(event)).toEqual(event);
    expect(analyticsDimensions(event)).toEqual(event.properties);
  });

  it.each([
    { name: "unknown", properties: {} },
    { name: "search_submitted", properties: { normalizedCategory: "identifier", queryLength: 6, identifierLike: true, query: "PRIVATE-100" } },
    { name: "zero_result", properties: { tokenClass: "words", email: "private@example.invalid" } },
    { name: "part_viewed", properties: { publicId: "x".repeat(121), confidenceTier: "verified_fit", safetyClass: "low" } },
    { name: "search_resolved", properties: { entityType: "model", matchClass: "strict_identifier", rank: 51, ambiguityCount: 0 } },
    { name: "missing_part_submitted", properties: { categoryMatch: "matched" } },
    { name: "missing_part_submitted", properties: { categoryMatch: "unmatched", category: "private-model" } },
  ])("rejects unknown, sensitive, excessive, or malformed event values", (event) => {
    expect(analyticsEventSchema.safeParse(event).success).toBe(false);
  });

  it("keeps contribution-completion events server-only", () => {
    for (const name of ["fit_report_submitted", "missing_part_submitted", "design_submitted"]) {
      const event = validEvents.find((candidate) => candidate.name === name)!;
      expect(browserAnalyticsEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("privacy-safe analytics classifiers", () => {
  it.each([
    ["RX-100", { normalizedCategory: "identifier", identifierLike: true, tokenClass: "alphanumeric", queryLength: 6 }],
    ["dust bin latch", { normalizedCategory: "component", identifierLike: false, tokenClass: "words", queryLength: 14 }],
    ["12345", { normalizedCategory: "identifier", identifierLike: true, tokenClass: "numeric", queryLength: 5 }],
    ["RX-100 dust latch", { normalizedCategory: "mixed", identifierLike: true, tokenClass: "mixed", queryLength: 17 }],
  ])("classifies a search without retaining %s", (query, expected) => {
    const classification = classifySearchForAnalytics(query);
    expect(classification).toEqual(expected);
    expect(JSON.stringify(classification)).not.toContain(query);
  });

  it.each([
    ["https://www.thingiverse.com/thing:1", "thingiverse"],
    ["https://models.printables.com/model/1", "printables"],
    ["https://makerworld.com/en/models/1", "makerworld"],
    ["https://evilthingiverse.com/private", "other"],
    ["not a url", "other"],
  ] as const)("classifies source platforms without retaining the URL", (url, expected) => {
    expect(classifyDesignSourcePlatform(url)).toBe(expected);
  });
});
