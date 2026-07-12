import { looseIdentifierKey, normalizeSearchQuery, strictIdentifierKey } from "./normalization";

export type SearchEntityType = "model" | "part";
export type SearchMatchKind = "strict_identifier" | "loose_identifier" | "model_component" | "text" | "trigram";

export interface SearchDocument {
  entityType: SearchEntityType;
  entityId: string;
  brandId: string;
  brandName: string;
  brandSlug: string;
  modelName: string;
  modelSlug: string;
  componentName: string | null;
  componentSlug: string | null;
  title: string;
  subtitle: string;
  href: string;
  strictKeys: string[];
  looseKeys: string[];
  componentTerms: string[];
  searchText: string;
}

export interface RankedSearchResult extends SearchDocument {
  score: number;
  matchKind: SearchMatchKind;
  matchReason: string;
}

export interface SearchAmbiguity {
  code: "MODEL_AMBIGUOUS" | "OEM_AMBIGUOUS";
  candidateIds: string[];
  remainingQuery: string;
}

export interface SearchRanking {
  results: RankedSearchResult[];
  ambiguity: SearchAmbiguity | null;
}

export function rankSearchDocuments(rawQuery: string, documents: readonly SearchDocument[]): SearchRanking {
  const query = normalizeSearchQuery(rawQuery);
  if (query.length < 2) return { results: [], ambiguity: null };

  const scoped = scopeDocuments(query, documents);
  const strictMatches = uniqueDocuments(scoped.filter((document) => matchesStrictIdentifier(query, document)));
  if (strictMatches.length > 0) return exactResolution(strictMatches, "strict_identifier");

  const looseMatches = uniqueDocuments(scoped.filter((document) => matchesLooseIdentifier(query, document)));
  if (looseMatches.length > 0) return exactResolution(looseMatches, "loose_identifier");

  const compoundModel = resolveCompoundModelIdentifier(query, scoped);
  if (compoundModel.kind === "ambiguous") {
    return exactResolution(compoundModel.documents, compoundModel.matchKind, compoundModel.remainingQuery);
  }
  if (compoundModel.kind === "resolved") {
    if (!compoundModel.remainingQuery) {
      return { results: [exactResult(compoundModel.document, compoundModel.matchKind, false)], ambiguity: null };
    }
    const withinExactModel = scoped.filter((document) =>
      document.brandId === compoundModel.document.brandId && document.modelSlug === compoundModel.document.modelSlug,
    );
    const compoundResults = withinExactModel
      .map((document) => rankTextCandidate(compoundModel.remainingQuery, document))
      .filter((result): result is RankedSearchResult => result !== null)
      .sort(compareResults);
    return {
      results: compoundResults.length > 0 ? compoundResults : [exactResult(compoundModel.document, compoundModel.matchKind, false)],
      ambiguity: null,
    };
  }

  const ranked = scoped
    .map((document) => rankTextCandidate(query, document))
    .filter((result): result is RankedSearchResult => result !== null)
    .sort(compareResults);
  return { results: ranked, ambiguity: null };
}

export function compareResults(left: RankedSearchResult, right: RankedSearchResult): number {
  return right.score - left.score || left.title.localeCompare(right.title, "en") || left.entityId.localeCompare(right.entityId, "en");
}

function exactResolution(
  documents: SearchDocument[],
  matchKind: "strict_identifier" | "loose_identifier",
  remainingQuery = "",
): SearchRanking {
  if (documents.length > 1) {
    return {
      results: documents.map((document) => exactResult(document, matchKind, true)).sort(compareResults),
      ambiguity: {
        code: documents.every((document) => document.entityType === "model") ? "MODEL_AMBIGUOUS" : "OEM_AMBIGUOUS",
        candidateIds: documents.map((document) => document.entityId).sort((left, right) => left.localeCompare(right, "en")),
        remainingQuery,
      },
    };
  }
  return { results: [exactResult(documents[0]!, matchKind, false)], ambiguity: null };
}

function exactResult(document: SearchDocument, matchKind: "strict_identifier" | "loose_identifier", ambiguous: boolean): RankedSearchResult {
  const isModel = document.entityType === "model";
  const strict = matchKind === "strict_identifier";
  return {
    ...document,
    score: ambiguous ? 0 : strict ? (isModel ? 1000 : 980) : (isModel ? 900 : 880),
    matchKind,
    matchReason: ambiguous
      ? "Choose the exact brand and variant"
      : strict
        ? isModel ? "Exact model identifier" : "Exact OEM part number"
        : isModel ? "Formatting-insensitive model identifier" : "Formatting-insensitive OEM part number",
  };
}

function rankTextCandidate(query: string, document: SearchDocument): RankedSearchResult | null {
  const normalizedQuery = query.toLocaleLowerCase("en");
  const normalizedText = normalizeSearchQuery(document.searchText).toLocaleLowerCase("en");
  const modelText = `${document.brandName} ${document.modelName}`.toLocaleLowerCase("en");
  const matchedComponent = [...document.componentTerms]
    .sort((left, right) => right.length - left.length)
    .find((term) => looseIdentifierKey(normalizedQuery).includes(looseIdentifierKey(term)));
  const modelQuery = matchedComponent ? normalizedQuery.replace(matchedComponent.toLocaleLowerCase("en"), " ") : normalizedQuery;
  const componentOnly = matchedComponent ? looseIdentifierKey(normalizedQuery) === looseIdentifierKey(matchedComponent) : false;
  const modelMatch = componentOnly || queryTokens(modelQuery).every((token) => modelText.includes(token) || document.looseKeys.some((key) => key.includes(looseIdentifierKey(token))));

  if (document.entityType === "part" && matchedComponent && modelMatch) {
    return { ...document, score: 800, matchKind: "model_component", matchReason: "Exact model and component" };
  }
  if (normalizedText.includes(normalizedQuery)) {
    return { ...document, score: document.entityType === "model" ? 720 : 700, matchKind: "text", matchReason: "Name or synonym" };
  }
  const similarity = trigramSimilarity(normalizedQuery, normalizedText);
  if (similarity < 0.22) return null;
  return {
    ...document,
    score: 400 + Math.round(similarity * 100),
    matchKind: "trigram",
    matchReason: "Close spelling match",
  };
}

type CompoundModelResolution =
  | { kind: "not_found" }
  | { kind: "resolved"; document: SearchDocument; matchKind: "strict_identifier" | "loose_identifier"; remainingQuery: string }
  | { kind: "ambiguous"; documents: SearchDocument[]; matchKind: "strict_identifier" | "loose_identifier"; remainingQuery: string };

function resolveCompoundModelIdentifier(query: string, documents: readonly SearchDocument[]): CompoundModelResolution {
  const modelDocuments = uniqueDocuments(documents.filter((document) => document.entityType === "model"));
  const identifierQuery = stripBrandTerms(query, modelDocuments);
  const tokens = identifierQuery.split(/\s+/).filter(Boolean);
  const windows = contiguousWindows(tokens, 4);

  const strict = bestCompoundMatches(windows, modelDocuments, "strict_identifier");
  if (strict) return compoundResolution(strict.documents, strict.matchKind, strict.remainingQuery);

  const loose = bestCompoundMatches(windows, modelDocuments, "loose_identifier");
  if (loose) return compoundResolution(loose.documents, loose.matchKind, loose.remainingQuery);
  return { kind: "not_found" };
}

function compoundResolution(
  documents: SearchDocument[],
  matchKind: "strict_identifier" | "loose_identifier",
  remainingQuery: string,
): CompoundModelResolution {
  return documents.length === 1
    ? { kind: "resolved", document: documents[0]!, matchKind, remainingQuery }
    : { kind: "ambiguous", documents, matchKind, remainingQuery };
}

interface QueryWindow {
  value: string;
  remainingQuery: string;
  consumedCharacters: number;
}

function contiguousWindows(tokens: string[], maximumTokens: number): QueryWindow[] {
  const windows: QueryWindow[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = 1; length <= maximumTokens && start + length <= tokens.length; length += 1) {
      const selected = tokens.slice(start, start + length);
      windows.push({
        value: selected.join(" "),
        remainingQuery: normalizeSearchQuery([...tokens.slice(0, start), ...tokens.slice(start + length)].join(" ")),
        consumedCharacters: selected.join("").length,
      });
    }
  }
  return windows.sort((left, right) => right.consumedCharacters - left.consumedCharacters);
}

function bestCompoundMatches(
  windows: QueryWindow[],
  documents: SearchDocument[],
  matchKind: "strict_identifier" | "loose_identifier",
): { documents: SearchDocument[]; matchKind: "strict_identifier" | "loose_identifier"; remainingQuery: string } | null {
  for (const window of windows) {
    const key = matchKind === "strict_identifier" ? strictIdentifierKey(window.value) : looseIdentifierKey(window.value);
    const matches = documents.filter((document) =>
      (matchKind === "strict_identifier" ? document.strictKeys : document.looseKeys).includes(key),
    );
    if (matches.length > 0) return { documents: uniqueDocuments(matches), matchKind, remainingQuery: window.remainingQuery };
  }
  return null;
}

function stripBrandTerms(query: string, documents: SearchDocument[]): string {
  const brandTerms = [...new Set(documents.flatMap((document) => [document.brandName, document.brandSlug]))]
    .sort((left, right) => right.length - left.length);
  let stripped = query;
  for (const brand of brandTerms) {
    stripped = stripped.replace(brandTermPattern(brand, true), "$1");
  }
  return normalizeSearchQuery(stripped);
}

function scopeDocuments(query: string, documents: readonly SearchDocument[]): SearchDocument[] {
  const normalized = query.toLocaleLowerCase("en");
  const mentionedBrandIds = new Set(
    documents
      .filter((document) => [document.brandName, document.brandSlug].some((brand) => brandTermPattern(brand).test(normalized)))
      .map((document) => document.brandId),
  );
  return mentionedBrandIds.size === 1 ? documents.filter((document) => mentionedBrandIds.has(document.brandId)) : [...documents];
}

function matchesStrictIdentifier(query: string, document: SearchDocument): boolean {
  return identifierQueries(query, document).some((candidate) => document.strictKeys.includes(strictIdentifierKey(candidate)));
}

function matchesLooseIdentifier(query: string, document: SearchDocument): boolean {
  return identifierQueries(query, document).some((candidate) => document.looseKeys.includes(looseIdentifierKey(candidate)));
}

function identifierQueries(query: string, document: SearchDocument): string[] {
  const stripped = query
    .replace(new RegExp(escapeRegExp(document.brandName), "ig"), " ")
    .replace(new RegExp(escapeRegExp(document.brandSlug), "ig"), " ");
  return [...new Set([query, normalizeSearchQuery(stripped)].filter((candidate) => candidate.length > 0))];
}

function queryTokens(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function uniqueDocuments(documents: SearchDocument[]): SearchDocument[] {
  return [...new Map(documents.map((document) => [`${document.entityType}:${document.entityId}`, document])).values()];
}

function trigramSimilarity(left: string, right: string): number {
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) return 0;
  let shared = 0;
  for (const trigram of leftTrigrams) if (rightTrigrams.has(trigram)) shared += 1;
  return (2 * shared) / (leftTrigrams.size + rightTrigrams.size);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value.replace(/\s+/g, " ")} `;
  const result = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) result.add(padded.slice(index, index + 3));
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function brandTermPattern(value: string, global = false): RegExp {
  return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(value)}(?=$|[^A-Z0-9])`, global ? "ig" : "i");
}
