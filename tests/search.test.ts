import { describe, expect, it } from "vitest";

import { rankSearchDocuments, type RankedSearchResult } from "@/domain/search";
import { decodeSearchCursor, paginateSearchResults } from "@/lib/search-pagination";
import { ambiguousSearchCorpusV1, searchCorpusDocuments, searchCorpusV1 } from "./fixtures/search-corpus-v1";

describe("production search ranking", () => {
  it("maintains at least 100 versioned fictional known-query cases", () => {
    expect(searchCorpusV1.length).toBeGreaterThanOrEqual(100);
  });

  it("ranks every known exact model and OEM fixture first", () => {
    const correct = searchCorpusV1.filter(({ query, expectedEntityId }) => {
      const ranking = rankSearchDocuments(query, searchCorpusDocuments);
      return ranking.ambiguity === null && ranking.results[0]?.entityId === expectedEntityId;
    });
    expect(correct.length / searchCorpusV1.length).toBeGreaterThanOrEqual(0.95);
  });

  it.each(ambiguousSearchCorpusV1)("never auto-resolves the loose collision: %s", (query) => {
    const ranking = rankSearchDocuments(query, searchCorpusDocuments);
    expect(ranking.ambiguity).toEqual({
      code: "MODEL_AMBIGUOUS",
      candidateIds: ["model-dv-100-dash", "model-dv-100-slash"],
      remainingQuery: "",
    });
    expect(ranking.results.every((result) => result.score === 0)).toBe(true);
  });

  it("uses component synonyms with an exact model without merging variants", () => {
    const ranking = rankSearchDocuments("CleanWave CW-020 basket roller", searchCorpusDocuments);
    expect(ranking.ambiguity).toBeNull();
    expect(ranking.results[0]).toMatchObject({ entityId: "part-wheel", matchKind: "model_component" });
  });

  it.each([
    ["DemoVac DV100 dust-bin latch", "dust-bin latch"],
    ["DemoVac DV100 bin clip", "bin clip"],
    ["DemoVac DV 100 dust bin latch", "dust bin latch"],
    ["DemoVac DV.100 bin clip", "bin clip"],
  ])("blocks an ambiguous loose model before ranking its component: %s", (query, remainingQuery) => {
    const ranking = rankSearchDocuments(query, searchCorpusDocuments);
    expect(ranking.ambiguity).toEqual({
      code: "MODEL_AMBIGUOUS",
      candidateIds: ["model-dv-100-dash", "model-dv-100-slash"],
      remainingQuery,
    });
    expect(ranking.results.map((result) => result.entityType)).toEqual(["model", "model"]);
    expect(ranking.results.every((result) => result.score === 0)).toBe(true);
  });

  it.each([
    "DemoVac DV-100 dust-bin latch",
    "DemoVac DV- 100 dust bin latch",
    "DemoVac DV‐100 bin clip",
  ])("resolves a strict compound model before ranking its component: %s", (query) => {
    const ranking = rankSearchDocuments(query, searchCorpusDocuments);
    expect(ranking.ambiguity).toBeNull();
    expect(ranking.results[0]).toMatchObject({ entityId: "part-latch", matchKind: "model_component" });
  });

  it("preserves strict slash punctuation in a spaced compound identifier", () => {
    const ranking = rankSearchDocuments("DemoVac DV / 100 dust-bin latch", searchCorpusDocuments);
    expect(ranking.ambiguity).toBeNull();
    expect(ranking.results[0]).toMatchObject({ entityId: "model-dv-100-slash", matchKind: "strict_identifier" });
    expect(ranking.results.some((result) => result.entityType === "part")).toBe(false);
  });

  it("distinguishes brand-scoped from unscoped compound ambiguity", () => {
    const otherBrandModel = {
      ...searchCorpusDocuments[0]!,
      entityId: "model-other-dv100",
      brandId: "brand-other",
      brandName: "OtherVac",
      brandSlug: "othervac",
      modelName: "DV100 Other Region",
      modelSlug: "dv100-other-region",
      title: "OtherVac DV100 Other Region",
      href: "/brands/othervac/dv100-other-region",
    };
    const documents = [...searchCorpusDocuments, otherBrandModel];

    expect(rankSearchDocuments("DemoVac DV100 dust-bin latch", documents).ambiguity?.candidateIds).toEqual([
      "model-dv-100-dash",
      "model-dv-100-slash",
    ]);
    expect(rankSearchDocuments("DV100 dust-bin latch", documents).ambiguity?.candidateIds).toEqual([
      "model-dv-100-dash",
      "model-dv-100-slash",
      "model-other-dv100",
    ]);
  });

  it("offers a close spelling fallback without treating it as exact", () => {
    const ranking = rankSearchDocuments("upper rack whell", searchCorpusDocuments);
    expect(ranking.results[0]).toMatchObject({ entityId: "part-wheel", matchKind: "trigram" });
  });
});

describe("search cursor", () => {
  const results = searchCorpusDocuments.slice(0, 3).map((document, index): RankedSearchResult => ({
    ...document,
    score: 700 - index,
    matchKind: "text",
    matchReason: "Fixture",
  }));

  it("paginates with a stable opaque cursor", () => {
    const first = paginateSearchResults(results, 2);
    expect(first.results.map((result) => result.entityId)).toEqual(["model-dv-100-dash", "model-dv-100-slash"]);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeSearchCursor(first.nextCursor!)).toMatchObject({ entityId: "model-dv-100-slash" });
    expect(paginateSearchResults(results, 2, first.nextCursor!).results.map((result) => result.entityId)).toEqual(["model-cw-020"]);
  });

  it("rejects malformed and stale cursors", () => {
    expect(() => paginateSearchResults(results, 2, "not-a-cursor")).toThrow("INVALID_CURSOR");
  });
});
