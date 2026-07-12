import type { RankedSearchResult, SearchAmbiguity } from "@/domain/search";
import { searchCatalog } from "./catalog";
import { paginateSearchResults } from "./search-pagination";

export interface PublicSearchPage {
  query: string;
  results: RankedSearchResult[];
  ambiguity: SearchAmbiguity | null;
  nextCursor: string | null;
}

export async function searchCatalogPage(
  query: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<PublicSearchPage> {
  const ranking = process.env.DEMO_MODE === "false"
    ? await import("@/db/search").then(({ searchPublicDocuments }) => searchPublicDocuments(query))
    : { results: demoRankedResults(query), ambiguity: null };
  const page = paginateSearchResults(ranking.results, options.limit ?? 20, options.cursor);
  return { query, results: page.results, ambiguity: ranking.ambiguity, nextCursor: page.nextCursor };
}

function demoRankedResults(query: string): RankedSearchResult[] {
  return searchCatalog(query).map((result, index) => ({
    entityType: result.type,
    entityId: `${result.type}:${result.href}`,
    brandId: "demo",
    brandName: "Demo",
    brandSlug: "demo",
    modelName: result.title,
    modelSlug: String(result.href),
    componentName: result.type === "part" ? result.title : null,
    componentSlug: null,
    title: result.title,
    subtitle: result.subtitle,
    href: String(result.href),
    strictKeys: [],
    looseKeys: [],
    componentTerms: [],
    searchText: `${result.title} ${result.subtitle}`,
    score: result.rank - index,
    matchKind: "text" as const,
    matchReason: result.matchReason,
  }));
}
