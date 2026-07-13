import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

import { classifySourceLinkStatus, parseRetryAfter, type SourceLinkObservation } from "@/domain/source-link-health";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PinnedResponse {
  readonly status: number;
  readonly location: string | null;
  readonly retryAfter: string | null;
  readonly responseMs: number;
}

export interface SourceNetworkDependencies {
  readonly resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly request: (url: URL, address: ResolvedAddress) => Promise<PinnedResponse>;
}

export class SourceNetworkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SourceNetworkError";
  }
}

export function validateSourceUrl(rawUrl: string, approvedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceNetworkError("SOURCE_URL_INVALID");
  }
  if (url.protocol !== "https:") throw new SourceNetworkError("SOURCE_URL_HTTPS_REQUIRED");
  if (url.username || url.password) throw new SourceNetworkError("SOURCE_URL_CREDENTIALS_FORBIDDEN");
  if (url.hash) throw new SourceNetworkError("SOURCE_URL_FRAGMENT_FORBIDDEN");
  if (url.port && url.port !== "443") throw new SourceNetworkError("SOURCE_URL_PORT_FORBIDDEN");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!approvedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    throw new SourceNetworkError("SOURCE_URL_HOST_FORBIDDEN");
  }
  return url;
}

export function isPublicNetworkAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function validateResolvedAddresses(
  url: URL,
  resolve: SourceNetworkDependencies["resolve"],
): Promise<readonly ResolvedAddress[]> {
  if (isIP(url.hostname) !== 0) throw new SourceNetworkError("SOURCE_URL_IP_LITERAL_FORBIDDEN");
  const addresses = await resolve(url.hostname);
  if (addresses.length === 0) throw new SourceNetworkError("SOURCE_DNS_EMPTY");
  if (addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
    throw new SourceNetworkError("SOURCE_DNS_FORBIDDEN_ADDRESS");
  }
  return addresses;
}

export async function checkSourceLink(
  rawUrl: string,
  approvedHosts: readonly string[],
  dependencies: SourceNetworkDependencies = defaultSourceNetworkDependencies,
  now: () => Date = () => new Date(),
): Promise<SourceLinkObservation> {
  let url = validateSourceUrl(rawUrl, approvedHosts);
  let redirectHops = 0;
  const visited = new Set<string>();

  try {
    while (true) {
      if (visited.has(url.href)) throw new SourceNetworkError("SOURCE_REDIRECT_LOOP");
      visited.add(url.href);
      const addresses = await validateResolvedAddresses(url, dependencies.resolve);
      const response = await dependencies.request(url, addresses[0]!);

      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new SourceNetworkError("SOURCE_REDIRECT_LOCATION_MISSING");
        redirectHops += 1;
        if (redirectHops > MAX_REDIRECTS) throw new SourceNetworkError("SOURCE_REDIRECT_LIMIT");
        url = validateSourceUrl(new URL(response.location, url).href, approvedHosts);
        continue;
      }

      const outcome = classifySourceLinkStatus(response.status);
      return Object.freeze({
        outcome: redirectHops > 0 && outcome === "healthy" ? "redirected" : outcome,
        httpStatus: response.status,
        finalUrl: url.href,
        responseMs: response.responseMs,
        errorCode: null,
        redirectHops,
        retryAfterAt: response.status === 429 ? parseRetryAfter(response.retryAfter, now()) : null,
      });
    }
  } catch (error) {
    const code = error instanceof SourceNetworkError ? error.code : "SOURCE_NETWORK_FAILURE";
    return Object.freeze({
      outcome: "transient_network_error",
      httpStatus: null,
      finalUrl: null,
      responseMs: null,
      errorCode: code,
      redirectHops,
      retryAfterAt: null,
    });
  }
}

export const defaultSourceNetworkDependencies: SourceNetworkDependencies = {
  resolve: async (hostname) => {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  },
  request: (url, resolved) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const request = httpsRequest(
        url,
        {
          headers: { "user-agent": "RepairPrint-LinkHealth/1.0", range: `bytes=0-${MAX_RESPONSE_BYTES - 1}` },
          lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) request.destroy(new SourceNetworkError("SOURCE_RESPONSE_TOO_LARGE"));
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              location: typeof response.headers.location === "string" ? response.headers.location : null,
              retryAfter: typeof response.headers["retry-after"] === "string" ? response.headers["retry-after"] : null,
              responseMs: Date.now() - startedAt,
            }),
          );
        },
      );
      request.on("timeout", () => request.destroy(new SourceNetworkError("SOURCE_NETWORK_TIMEOUT")));
      request.on("error", reject);
      request.end();
    }),
};
