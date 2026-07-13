import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isMaterialSourceRedirect } from "../src/domain/source-link-health";
import { checkSourceLink, isPublicNetworkAddress, validateSourceUrl, type PinnedResponse } from "../src/lib/safe-source-network";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    switch (request.url) {
      case "/ok": response.writeHead(200).end("ok"); break;
      case "/redirect": response.writeHead(302, { location: "/ok" }).end(); break;
      case "/loop-a": response.writeHead(302, { location: "/loop-b" }).end(); break;
      case "/loop-b": response.writeHead(302, { location: "/loop-a" }).end(); break;
      case "/removed": response.writeHead(404).end(); break;
      case "/gone": response.writeHead(410).end(); break;
      case "/unauthorized": response.writeHead(401).end(); break;
      case "/forbidden": response.writeHead(403).end(); break;
      case "/rate": response.writeHead(429, { "retry-after": "120" }).end(); break;
      case "/server-error": response.writeHead(503).end(); break;
      case "/timeout": setTimeout(() => response.writeHead(200).end(), 100); break;
      default: response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind.");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

const dependencies = {
  resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
  request: async (url: URL): Promise<PinnedResponse> => {
    const started = Date.now();
    const response = await fetch(`${origin}${url.pathname}`, { redirect: "manual", signal: AbortSignal.timeout(25) });
    return {
      status: response.status,
      location: response.headers.get("location"),
      retryAfter: response.headers.get("retry-after"),
      responseMs: Date.now() - started,
    };
  },
};

describe("bounded source link checker", () => {
  it.each([
    ["/ok", "healthy", 200],
    ["/redirect", "redirected", 200],
    ["/removed", "removed", 404],
    ["/gone", "removed", 410],
    ["/unauthorized", "restricted", 401],
    ["/forbidden", "restricted", 403],
    ["/rate", "transient_rate_limited", 429],
    ["/server-error", "transient_server_error", 503],
  ])("classifies %s deterministically", async (path, outcome, status) => {
    const result = await checkSourceLink(`https://www.thingiverse.com${path}`, ["www.thingiverse.com"], dependencies, () => new Date("2026-07-13T00:00:00.000Z"));
    expect(result).toMatchObject({ outcome, httpStatus: status });
  });

  it("retains Retry-After for rate limiting", async () => {
    const result = await checkSourceLink("https://www.thingiverse.com/rate", ["www.thingiverse.com"], dependencies, () => new Date("2026-07-13T00:00:00.000Z"));
    expect(result.retryAfterAt?.toISOString()).toBe("2026-07-13T00:02:00.000Z");
  });

  it.each([
    ["/timeout", "SOURCE_NETWORK_FAILURE"],
    ["/loop-a", "SOURCE_REDIRECT_LOOP"],
  ])("sanitizes %s failures", async (path, errorCode) => {
    const result = await checkSourceLink(`https://www.thingiverse.com${path}`, ["www.thingiverse.com"], dependencies);
    expect(result).toMatchObject({ outcome: "transient_network_error", errorCode });
  });

  it.each([
    "http://www.thingiverse.com/thing:1",
    "https://user:pass@www.thingiverse.com/thing:1",
    "https://www.thingiverse.com:444/thing:1",
    "https://www.thingiverse.com/thing:1#files",
    "https://evil.example/thing:1",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateSourceUrl(url, ["www.thingiverse.com"])).toThrow();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "224.0.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("blocks non-public address %s", (address) => expect(isPublicNetworkAddress(address)).toBe(false));

  it("fails closed when any DNS answer is forbidden", async () => {
    const result = await checkSourceLink("https://www.thingiverse.com/ok", ["www.thingiverse.com"], {
      ...dependencies,
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(result).toMatchObject({ outcome: "transient_network_error", errorCode: "SOURCE_DNS_FORBIDDEN_ADDRESS" });
  });

  it.each([
    ["https://example.com/item/42", "https://example.com/item/42/", false],
    ["https://example.com/item/42", "https://example.com/item/43", true],
    ["https://example.com/item/42", "https://other.example/item/42", true],
    ["https://example.com/item/42", "not a url", true],
  ])("classifies material redirect %s -> %s", (canonical, final, expected) => {
    expect(isMaterialSourceRedirect(canonical, final)).toBe(expected);
  });
});
