import { looseIdentifierKey, normalizeSearchQuery, strictIdentifierKey } from "@/domain/normalization";
import { rankSearchDocuments, type SearchDocument, type SearchRanking } from "@/domain/search";
import { databaseClient } from "./client";

interface SearchDocumentRow {
  entity_type: "model" | "part";
  entity_id: string;
  brand_id: string;
  brand_name: string;
  brand_slug: string;
  model_name: string;
  model_slug: string;
  component_name: string | null;
  component_slug: string | null;
  title: string;
  subtitle: string;
  href: string;
  strict_keys: string[];
  loose_keys: string[];
  component_terms: string[];
  search_text: string;
}

export async function searchPublicDocuments(rawQuery: string): Promise<SearchRanking> {
  const query = normalizeSearchQuery(rawQuery);
  if (query.length < 2) return { results: [], ambiguity: null };

  const strictKey = strictIdentifierKey(query);
  const looseKey = looseIdentifierKey(query);
  // Launch scope is capped at 100–200 public records. Read the bounded public
  // view so a brand prefix cannot hide an otherwise exact identifier match;
  // the pure ranker then applies strict/loose and ambiguity rules.
  const rows = await databaseClient<SearchDocumentRow[]>`
    SELECT *
    FROM public_search_documents
    ORDER BY
      CASE WHEN ${strictKey} = ANY(strict_keys) THEN 0 WHEN ${looseKey} = ANY(loose_keys) THEN 1 ELSE 2 END,
      similarity(search_text, ${query.toLocaleLowerCase("en")}) DESC,
      title,
      entity_id
    LIMIT 250
  `;
  return rankSearchDocuments(query, rows.map(toDocument));
}

function toDocument(row: SearchDocumentRow): SearchDocument {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    brandId: row.brand_id,
    brandName: row.brand_name,
    brandSlug: row.brand_slug,
    modelName: row.model_name,
    modelSlug: row.model_slug,
    componentName: row.component_name,
    componentSlug: row.component_slug,
    title: row.title,
    subtitle: row.subtitle,
    href: row.href,
    strictKeys: row.strict_keys,
    looseKeys: row.loose_keys,
    componentTerms: row.component_terms,
    searchText: row.search_text,
  };
}
