import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { evaluateSeoRequestBoundary } from "@/domain/seo";
import { currentSeoRuntime } from "@/lib/seo";

export function proxy(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const runtime = currentSeoRuntime();
  const boundary = evaluateSeoRequestBoundary(
    runtime,
    request.nextUrl.pathname,
    request.nextUrl.searchParams.size > 0,
  );
  if (boundary) response.headers.set("x-robots-tag", `noindex, ${boundary.follow ? "follow" : "nofollow"}, noarchive`);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
