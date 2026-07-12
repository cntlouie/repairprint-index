import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { searchCatalogPage } from "@/lib/search";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.trim().length < 2) {
    return NextResponse.json({ error: "QUERY_TOO_SHORT", results: [] }, { status: 400 });
  }
  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    return NextResponse.json({ error: "INVALID_LIMIT", results: [] }, { status: 400 });
  }
  try {
    const page = await searchCatalogPage(query, { cursor, limit: requestedLimit });
    return NextResponse.json({
      query: page.query,
      results: page.results.map(({ score, matchKind, matchReason, entityType, entityId, title, subtitle, href }) => ({
        type: entityType,
        id: entityId,
        title,
        subtitle,
        href,
        score,
        matchKind,
        matchReason,
      })),
      ambiguity: page.ambiguity,
      page: { nextCursor: page.nextCursor },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CURSOR") {
      return NextResponse.json({ error: "INVALID_CURSOR", results: [] }, { status: 400 });
    }
    throw error;
  }
}
