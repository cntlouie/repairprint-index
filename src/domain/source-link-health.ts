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
}

export function classifySourceLinkStatus(status: number): SourceLinkOutcome {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "restricted";
  if (status === 404 || status === 410) return "removed";
  if (status === 429) return "transient_rate_limited";
  if (status >= 500) return "transient_server_error";
  return "transient_network_error";
}

export function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return new Date(now.getTime() + Number(value) * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime() ? new Date(timestamp) : null;
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
