import type { RankedSearchResult, SearchAmbiguity } from "@/domain/search";
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
    : { results: [], ambiguity: null };
  const page = paginateSearchResults(ranking.results, options.limit ?? 20, options.cursor);
  return { query, results: page.results, ambiguity: ranking.ambiguity, nextCursor: page.nextCursor };
}
