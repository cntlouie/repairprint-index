export type SourceLinkOutcome =
  | "healthy"
  | "redirected"
  | "removed"
  | "restricted"
  | "transient_rate_limited"
  | "transient_server_error"
  | "transient_network_error";

export interface SourceLinkObservation {
  readonly outcome: SourceLinkOutcome;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly responseMs: number | null;
  readonly errorCode: string | null;
  readonly redirectHops: number;
  readonly retryAfterAt: Date | null;
  readonly contentChecksum: string | null;
}

export const SOURCE_RETRY_AFTER_MIN_MS = 60_000;
export const SOURCE_RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

export function classifySourceLinkStatus(status: number): SourceLinkOutcome {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403 || status === 451) return "restricted";
  if (status === 404 || status === 410) return "removed";
  if (status === 429) return "transient_rate_limited";
  if (status >= 500) return "transient_server_error";
  return "transient_network_error";
}

export function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (!value) return null;
  let requestedAt: number;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return null;
    requestedAt = now.getTime() + seconds * 1000;
  } else {
    requestedAt = Date.parse(value);
    if (!Number.isFinite(requestedAt)) return null;
  }
  const boundedAt = Math.min(
    Math.max(requestedAt, now.getTime() + SOURCE_RETRY_AFTER_MIN_MS),
    now.getTime() + SOURCE_RETRY_AFTER_MAX_MS,
  );
  return new Date(boundedAt);
}

export function isConfirmedSourceRemoval(outcome: SourceLinkOutcome): boolean {
  return outcome === "removed" || outcome === "restricted";
}

export function isMaterialSourceRedirect(canonicalUrl: string, finalUrl: string): boolean {
  try {
    return normalizedComparisonUrl(canonicalUrl) !== normalizedComparisonUrl(finalUrl);
  } catch {
    return true;
  }
}

function normalizedComparisonUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}
