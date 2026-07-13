const baseUrl = requiredOrigin("WP11_BASE_URL");
const canonicalOrigin = requiredOrigin("WP11_CANONICAL_ORIGIN");
const expectDemo = process.env.WP11_EXPECT_DEMO === "true";

async function main(): Promise<void> {
  const robots = await fetchText("/robots.txt", 200);
  const sitemap = await fetchText("/sitemap.xml", 200);
  const urlEntries = [...sitemap.body.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => parseSitemapEntry(match[1]!));
  const locations = urlEntries.map((entry) => entry.location);

  if (expectDemo) {
    assertMatch(robots.body, /User-Agent:\s*\*[\s\S]*Disallow:\s*\//iu, "demo robots must block every crawler");
    assert(!/^Sitemap:/imu.test(robots.body), "demo robots must not advertise a sitemap");
    assert(locations.length === 0, `demo sitemap must be empty, found ${locations.length} URLs`);
    console.log("Sitemap/canonical/indexability HTTP gate passed: demo crawling is blocked and the sitemap is empty.");
    return;
  }

  assertMatch(robots.body, new RegExp(`Sitemap:\\s*${escapeRegExp(canonicalOrigin)}/sitemap\\.xml`, "iu"), "production robots sitemap URL");
  assert(locations.length === new Set(locations).size, "every sitemap URL must be unique");

  const expectedPaths = new Set([
    "/",
    "/methodology",
    "/safety",
    "/licensing",
    "/privacy",
    "/corrections",
    "/notice",
    "/independence",
    "/brands/renderworks/rx-100",
    "/brands/renderworks/rx-100-eu",
    "/parts/render-rx100-latch-r1",
  ]);
  const actualPaths = new Set<string>();
  for (const location of locations) {
    const parsed = new URL(location);
    assert(parsed.origin === canonicalOrigin, `sitemap URL is off-origin: ${location}`);
    assert(!parsed.search && !parsed.hash, `sitemap URL contains a query or fragment: ${location}`);
    assert(parsed.username === "" && parsed.password === "", `sitemap URL contains credentials: ${location}`);
    actualPaths.add(parsed.pathname);
    const entry = urlEntries.find((candidate) => candidate.location === location)!;
    assert(entry.lastModified !== null, `${parsed.pathname} is missing lastmod`);
    assert(Number.isFinite(Date.parse(entry.lastModified)), `${parsed.pathname} has an invalid lastmod: ${entry.lastModified}`);

    const page = await fetchText(parsed.pathname, 200);
    assert(!/x-robots-tag[^\n]*noindex/iu.test(headersText(page.headers)), `${parsed.pathname} has an X-Robots noindex directive`);
    assert(!/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/iu.test(page.body), `${parsed.pathname} has a noindex meta directive`);
    const canonicals = [...page.body.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/giu)].map((match) => decodeHtml(match[1]!));
    assert(canonicals.length === 1, `${parsed.pathname} must have exactly one canonical link; found ${canonicals.length}`);
    assert(
      new URL(canonicals[0]!).href === new URL(location).href,
      `${parsed.pathname} canonical ${canonicals[0] ?? "missing"} does not self-reference ${location}`,
    );
  }
  assertSetEqual(actualPaths, expectedPaths, "fictional production sitemap paths");

  for (const forbidden of [
    "/search",
    "/request-part",
    "/submit-design",
    "/confirm-fit",
    "/contribution-privacy",
    "/admin",
    "/api/v1/search",
    "/parts/render-removed-latch-r1",
    "/parts/render-historical-latch",
    "/parts/render-private-latch-r1",
    "/brands/renderworks/rx-empty",
  ]) {
    assert(!actualPaths.has(forbidden), `${forbidden} entered the sitemap`);
  }

  for (const route of ["/search?q=RX-100", "/request-part", "/submit-design", "/confirm-fit", "/contribution-privacy", "/admin", "/brands/renderworks/rx-empty"]) {
    const response = await fetchText(route, 200);
    const directives = `${response.headers.get("x-robots-tag") ?? ""} ${response.body}`;
    assert(/noindex/iu.test(directives), `${route} did not return a noindex directive`);
  }
  const api = await fetch(new URL("/api/v1/search?q=RX-100", baseUrl), { redirect: "manual" });
  assert(/noindex/iu.test(api.headers.get("x-robots-tag") ?? ""), "public search API did not return X-Robots noindex");
  const tombstone = await fetchText("/parts/render-removed-latch-r1", 200);
  assert(/noindex/iu.test(`${tombstone.headers.get("x-robots-tag") ?? ""} ${tombstone.body}`), "unavailable source tombstone must be noindex");

  const historical = await fetch(new URL("/parts/render-historical-latch", baseUrl), { redirect: "manual" });
  assert([301, 308].includes(historical.status), `historical slug returned ${historical.status}, expected permanent redirect`);
  assert(historical.headers.get("location") === "/parts/render-rx100-latch-r1", "historical slug did not redirect to the canonical part");

  assertEntryLastModified(urlEntries, "/brands/renderworks/rx-100", "2026-07-12");
  assertEntryLastModified(urlEntries, "/parts/render-rx100-latch-r1", "2026-07-12");
  console.log(`Sitemap/canonical/indexability HTTP gate passed: ${locations.length} unique, 200, self-canonical production URLs.`);
}

async function fetchText(pathname: string, expectedStatus: number): Promise<Readonly<{ body: string; headers: Headers }>> {
  const response = await fetch(new URL(pathname, baseUrl), { redirect: "manual" });
  if (response.status !== expectedStatus) throw new Error(`${pathname} returned ${response.status}; expected ${expectedStatus}.`);
  return { body: await response.text(), headers: response.headers };
}

function requiredOrigin(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required.`);
  const parsed = new URL(raw);
  if (parsed.origin !== raw || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} must be an exact absolute origin.`);
  }
  return parsed.origin;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertMatch(value: string, pattern: RegExp, message: string): void {
  assert(pattern.test(value), message);
}

function assertSetEqual(actual: Set<string>, expected: Set<string>, label: string): void {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  assert(missing.length === 0 && unexpected.length === 0, `${label} mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`);
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
}

function decodeHtml(value: string): string {
  return decodeXml(value).replaceAll("&#x2F;", "/").replaceAll("&#47;", "/");
}

function parseSitemapEntry(block: string): Readonly<{ lastModified: string | null; location: string }> {
  const locations = [...block.matchAll(/<loc>([^<]+)<\/loc>/gu)];
  assert(locations.length === 1, `sitemap URL block must contain exactly one loc; found ${locations.length}`);
  const lastModified = block.match(/<lastmod>([^<]+)<\/lastmod>/u)?.[1] ?? null;
  return Object.freeze({
    lastModified: lastModified === null ? null : decodeXml(lastModified),
    location: decodeXml(locations[0]![1]!),
  });
}

function assertEntryLastModified(
  entries: readonly Readonly<{ lastModified: string | null; location: string }>[],
  pathname: string,
  expectedPrefix: string,
): void {
  const entry = entries.find((candidate) => new URL(candidate.location).pathname === pathname);
  assert(Boolean(entry), `${pathname} is missing from the sitemap`);
  assert(entry!.lastModified?.startsWith(expectedPrefix) === true,
    `${pathname} lastmod ${entry!.lastModified ?? "missing"} does not use ${expectedPrefix} material fixture data`);
}

function headersText(headers: Headers): string {
  return [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sitemap/canonical/indexability gate failed.");
  process.exitCode = 1;
});
