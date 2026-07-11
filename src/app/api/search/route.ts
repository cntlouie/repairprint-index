import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { searchCatalog } from "@/lib/catalog";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.trim().length < 2) {
    return NextResponse.json({ error: "QUERY_TOO_SHORT", results: [] }, { status: 400 });
  }
  return NextResponse.json({ query, results: searchCatalog(query).slice(0, 20) });
}
