import { compareResults, type RankedSearchResult } from "@/domain/search";

interface SearchCursor {
  score: number;
  title: string;
  entityId: string;
}

export function paginateSearchResults(
  results: readonly RankedSearchResult[],
  limit: number,
  cursor?: string,
): { results: RankedSearchResult[]; nextCursor: string | null } {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const ordered = [...results].sort(compareResults);
  const after = cursor ? afterCursor(ordered, decodeSearchCursor(cursor)) : ordered;
  const page = after.slice(0, safeLimit);
  return {
    results: page,
    nextCursor: after.length > safeLimit ? encodeSearchCursor(page[page.length - 1]!) : null,
  };
}

export function encodeSearchCursor(result: Pick<RankedSearchResult, "score" | "title" | "entityId">): string {
  return Buffer.from(JSON.stringify({ score: result.score, title: result.title, entityId: result.entityId }), "utf8").toString("base64url");
}

export function decodeSearchCursor(value: string): SearchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchCursor>;
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score) || typeof parsed.title !== "string" || typeof parsed.entityId !== "string") {
      throw new Error("shape");
    }
    return { score: parsed.score, title: parsed.title, entityId: parsed.entityId };
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}

function afterCursor(results: RankedSearchResult[], cursor: SearchCursor): RankedSearchResult[] {
  const index = results.findIndex((result) => result.score === cursor.score && result.title === cursor.title && result.entityId === cursor.entityId);
  if (index < 0) throw new Error("INVALID_CURSOR");
  return results.slice(index + 1);
}
