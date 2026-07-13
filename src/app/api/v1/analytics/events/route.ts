import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { browserAnalyticsEventSchema, type BrowserAnalyticsEvent } from "@/domain/analytics";
import { parseSiteOrigin } from "@/domain/seo";
import { bestEffortRecordAnalyticsEvent } from "@/lib/analytics";

const MAX_ANALYTICS_EVENT_BYTES = 4_096;
const privateResponseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

type AnalyticsEventRecorder = (event: BrowserAnalyticsEvent) => Promise<unknown>;

export async function handleBrowserAnalyticsEvent(
  request: NextRequest,
  record: AnalyticsEventRecorder = bestEffortRecordAnalyticsEvent,
): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const candidate = await readAnalyticsEvent(request);
    const parsed = browserAnalyticsEventSchema.safeParse(candidate);
    if (!parsed.success) return analyticsError("INVALID_ANALYTICS_EVENT", 400);

    try {
      await record(parsed.data);
    } catch {
      // The endpoint must never make the user journey depend on analytics.
      console.error({ code: "ANALYTICS_EVENT_DROPPED", eventName: parsed.data.name });
    }
    return NextResponse.json({ accepted: true }, { headers: privateResponseHeaders, status: 202 });
  } catch (error) {
    if (error instanceof AnalyticsRequestError) return analyticsError(error.code, error.status);
    return analyticsError("INVALID_ANALYTICS_EVENT", 400);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleBrowserAnalyticsEvent(request);
}

function assertSameOrigin(request: NextRequest): void {
  const supplied = request.headers.get("origin");
  const configured = parseSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  const allowedOrigin = configured.valid
    ? configured.origin
    : process.env.DEMO_MODE !== "false"
      ? request.nextUrl.origin
      : null;

  if (!allowedOrigin || !supplied || supplied === "null" || supplied !== allowedOrigin) {
    throw new AnalyticsRequestError("ANALYTICS_ORIGIN_FORBIDDEN", 403);
  }
}

async function readAnalyticsEvent(request: NextRequest): Promise<unknown> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw new AnalyticsRequestError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AnalyticsRequestError("INVALID_ANALYTICS_EVENT", 400);
    }
    if (length > MAX_ANALYTICS_EVENT_BYTES) {
      throw new AnalyticsRequestError("PAYLOAD_TOO_LARGE", 413);
    }
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AnalyticsRequestError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  const bytes = await readBoundedBytes(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AnalyticsRequestError("INVALID_ANALYTICS_EVENT", 400);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnalyticsRequestError("INVALID_ANALYTICS_EVENT", 400);
  }
}

async function readBoundedBytes(request: NextRequest): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANALYTICS_EVENT_BYTES) {
      await reader.cancel();
      throw new AnalyticsRequestError("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function analyticsError(code: AnalyticsRequestError["code"], status: number): NextResponse {
  return NextResponse.json(
    { error: { code } },
    { headers: privateResponseHeaders, status },
  );
}

class AnalyticsRequestError extends Error {
  constructor(
    readonly code:
      | "ANALYTICS_ORIGIN_FORBIDDEN"
      | "INVALID_ANALYTICS_EVENT"
      | "PAYLOAD_TOO_LARGE"
      | "UNSUPPORTED_MEDIA_TYPE",
    readonly status: number,
  ) {
    super(code);
    this.name = "AnalyticsRequestError";
  }
}
