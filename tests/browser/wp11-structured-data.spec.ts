import { expect, test, type Page } from "@playwright/test";

const forbiddenProperties = new Set([
  "aggregateRating",
  "review",
  "offers",
  "price",
  "priceCurrency",
  "availability",
  "faq",
  "endorsement",
  "manufacturer",
]);

test("homepage WebSite data uses the visible real search action", async ({ page, baseURL }) => {
  await page.goto("/");
  const nodes = await structuredNodes(page);
  const website = findType(nodes, "WebSite");
  expect(website).toBeDefined();
  expect(website!.url).toBe(new URL("/", baseURL).toString());
  const action = website!.potentialAction as Record<string, unknown>;
  expect(action["@type"]).toBe("SearchAction");
  expect(action.target).toBe(`${new URL("/search", baseURL).toString()}?q={search_term_string}`);
  await expect(page.getByRole("search").locator('input[name="q"]')).toBeVisible();
  await assertSupportedAndCanonical(nodes, page, baseURL!);
});

test("exact-model CollectionPage and breadcrumbs contain only visible facts", async ({ page, baseURL }) => {
  await page.goto("/brands/renderworks/rx-100");
  const nodes = await structuredNodes(page);
  const collection = findType(nodes, "CollectionPage");
  const breadcrumbs = findType(nodes, "BreadcrumbList");
  expect(collection).toBeDefined();
  expect(breadcrumbs).toBeDefined();
  const visible = normalize(await page.locator("main").innerText());
  await expect(page.getByRole("heading", { level: 1 })).toContainText(String(collection!.name));
  expect(visible).toContain(normalize(String(collection!.description)));
  await expect(page.locator(`time[datetime="${String(collection!.dateModified)}"]`).first()).toBeVisible();
  const itemList = collection!.mainEntity as Record<string, unknown>;
  const items = itemList.itemListElement as Array<Record<string, unknown>>;
  expect(itemList.numberOfItems).toBe(items.length);
  for (const item of items) {
    expect(visible).toContain(normalize(String(item.name)));
    await expect(page.locator(`main a[href="${new URL(String(item.item)).pathname}"]`).first()).toBeVisible();
  }
  await assertBreadcrumbFactsVisible(page, breadcrumbs!, baseURL!);
  await assertSupportedAndCanonical(nodes, page, baseURL!);
});

test("canonical-part CreativeWork and breadcrumbs match ordinary page content", async ({ page, baseURL }) => {
  await page.goto("/parts/render-rx100-latch-r1");
  const nodes = await structuredNodes(page);
  const creativeWork = findType(nodes, "CreativeWork");
  const breadcrumbs = findType(nodes, "BreadcrumbList");
  expect(creativeWork).toBeDefined();
  expect(breadcrumbs).toBeDefined();
  const visible = normalize(await page.locator("main").innerText());
  expect(visible).toContain(normalize(String(creativeWork!.name)));
  const creator = creativeWork!.creator as Record<string, unknown>;
  expect(visible).toContain(normalize(String(creator.name)));
  if (creativeWork!.identifier) expect(visible).toContain(normalize(String(creativeWork!.identifier)));
  if (creativeWork!.about) expect(visible).toContain(normalize(String(creativeWork!.about)));
  if (creativeWork!.dateModified) {
    await expect(page.locator(`time[datetime="${String(creativeWork!.dateModified)}"]`).first()).toBeVisible();
  }
  await assertBreadcrumbFactsVisible(page, breadcrumbs!, baseURL!);
  await assertSupportedAndCanonical(nodes, page, baseURL!);
});

async function structuredNodes(page: Page): Promise<Record<string, unknown>[]> {
  const values = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(values.length).toBeGreaterThan(0);
  const nodes: Record<string, unknown>[] = [];
  for (const value of values) {
    expect(value.toLocaleLowerCase("en")).not.toContain("</script");
    const parsed = JSON.parse(value) as Record<string, unknown> | Record<string, unknown>[];
    nodes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return nodes.flatMap((node) => Array.isArray(node["@graph"]) ? node["@graph"] as Record<string, unknown>[] : [node]);
}

function findType(nodes: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return nodes.find((node) => node["@type"] === type || (Array.isArray(node["@type"]) && node["@type"].includes(type)));
}

async function assertBreadcrumbFactsVisible(page: Page, breadcrumbs: Record<string, unknown>, baseURL: string): Promise<void> {
  const visible = normalize(await page.getByRole("navigation", { name: "Breadcrumb" }).innerText());
  const elements = (breadcrumbs.itemListElement ?? []) as Array<Record<string, unknown>>;
  expect(elements.length).toBeGreaterThanOrEqual(2);
  for (const element of elements) {
    expect(visible).toContain(normalize(String(element.name)));
    expect(new URL(String(element.item)).origin).toBe(new URL(baseURL).origin);
  }
}

async function assertSupportedAndCanonical(nodes: Record<string, unknown>[], page: Page, baseURL: string): Promise<void> {
  const canonicalOrigin = new URL(baseURL).origin;
  walk(nodes, (key, value) => {
    expect(forbiddenProperties.has(key), `unsupported structured property ${key}`).toBe(false);
    if (["url", "item", "@id"].includes(key) && typeof value === "string") {
      expect(new URL(value).origin, `${key} is off canonical origin: ${value}`).toBe(canonicalOrigin);
      expect(new URL(value).search, `${key} contains a query: ${value}`).toBe("");
      expect(new URL(value).hash, `${key} contains a fragment: ${value}`).toBe("");
    }
    if (key === "target" && typeof value === "string") {
      const expanded = new URL(value.replace("{search_term_string}", "fixture"));
      expect(expanded.origin).toBe(canonicalOrigin);
      expect(expanded.pathname).toBe("/search");
      expect(expanded.searchParams.get("q")).toBe("fixture");
      expect(expanded.hash).toBe("");
    }
  });
  const html = await page.content();
  expect(html).not.toMatch(/reviewCount|priceCurrency|itemAvailability/iu);
}

function walk(value: unknown, visitor: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visitor(key, child);
    walk(child, visitor);
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
