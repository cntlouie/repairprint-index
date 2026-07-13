import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const publicJourneys = [
  ["homepage", "/"],
  ["exact search", "/search?q=RX-100"],
  ["ambiguous search", "/search?q=RX100"],
  ["zero-result search", "/search?q=NO-MATCH-999"],
  ["exact model", "/brands/renderworks/rx-100"],
  ["canonical part", "/parts/render-rx100-latch-r1"],
  ["missing-part form", "/request-part"],
  ["design form", "/submit-design"],
  ["fit-report form", "/confirm-fit?part=render-rx100-latch-r1"],
  ["methodology", "/methodology"],
  ["safety", "/safety"],
  ["licensing", "/licensing"],
  ["general privacy", "/privacy"],
  ["corrections", "/corrections"],
  ["notices", "/notice"],
  ["independence", "/independence"],
  ["contribution privacy", "/contribution-privacy"],
] as const;

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route("**/*", async (route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (requestOrigin !== origin) await route.abort("blockedbyclient");
    else await route.continue();
  });
});

for (const [label, path] of publicJourneys) {
  test(`${label} has no WCAG 2.2 A/AA axe violations`, async ({ page }) => {
    await gotoPublicPage(page, path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}

test("skip link and primary public navigation have a visible logical keyboard order", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#site-search")).toBeFocused();

  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "RepairPrint Index home" })).toBeFocused();
  await assertVisibleFocus(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Search", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Request a part" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Submit a design" })).toBeFocused();
});

test("keyboard-only search supports exact, ambiguous, and zero-result outcomes", async ({ page }) => {
  await page.goto("/");
  await tabTo(page, "#site-search");
  await page.keyboard.type("RX-100");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=RX-100$/u);
  await expect(page.getByRole("heading", { name: /result/u })).toBeVisible();

  await page.goto("/search?q=RX100");
  await expect(page.getByRole("status")).toContainText("will not guess or preselect");
  const ambiguousLinks = page.locator(".result-list a");
  await expect(ambiguousLinks).toHaveCount(2);
  await tabTo(page, ".result-list a");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/brands\/renderworks\//u);

  await page.goto("/search?q=NO-MATCH-999");
  await expect(page.getByRole("status")).toContainText("No exact match yet");
  await expect(page.getByRole("link", { name: "Request this part" })).toBeVisible();
});

for (const [path, firstRequiredId, validFirstValue] of [
  ["/request-part", "request-brand", "RenderWorks"],
  ["/submit-design", "design-url", "https://example.com/original-design"],
  ["/confirm-fit", "fit-part-slug", "render-rx100-latch-r1"],
] as const) {
  test(`${path} summarizes invalid fields and links keyboard users back to them`, async ({ page }) => {
    await gotoPublicPage(page, path);
    await expect(page.locator('[data-validation-ready="true"]')).toHaveCount(1);
    await tabTo(page, 'button[type="submit"]', 50);
    await page.keyboard.press("Enter");

    const summary = page.getByRole("alert", { name: "Check the form" });
    const firstField = page.locator(`#${firstRequiredId}`);
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await assertVisibleFocus(page);
    await expect(firstField).toHaveAttribute("aria-invalid", "true");
    await expect(firstField).toHaveAttribute("aria-describedby", new RegExp(`(?:^|\\s)validation-error-${firstRequiredId}(?:\\s|$)`, "u"));

    await summary.locator(`a[href="#${firstRequiredId}"]`).click();
    await expect(firstField).toBeFocused();
    await assertVisibleFocus(page);
    await firstField.fill(validFirstValue);
    await expect(firstField).not.toHaveAttribute("aria-invalid", "true");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}

test("validation feedback never repeats a private field value", async ({ page }) => {
  await gotoPublicPage(page, "/submit-design");
  await expect(page.locator('[data-validation-ready="true"]')).toHaveCount(1);
  const privateSentinel = "WP11_PRIVATE_FIELD_VALUE_SENTINEL";
  await page.locator("#design-url").fill(privateSentinel);
  await page.locator('button[type="submit"]').click();
  const summary = page.getByRole("alert", { name: "Check the form" });
  await expect(summary).toBeFocused();
  await expect(summary).not.toContainText(privateSentinel);
  await expect(summary).toContainText("Enter a valid Original design URL.");
});

test("native form action and constraint validation still work without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/request-part", { waitUntil: "domcontentloaded" });
    const form = page.locator("form");
    await expect(form).toHaveAttribute("action", "/api/v1/submissions/requests");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form).not.toHaveAttribute("novalidate", "");
    await page.locator('button[type="submit"]').click();
    await expect(page.locator("#request-brand")).toBeFocused();
    await expect(page).toHaveURL(/\/request-part$/u);
  } finally {
    await context.close();
  }
});

test("submission success and the real HTML failure journey announce and receive focus", async ({ page }) => {
  await gotoPublicPage(page, "/request-part?submitted=1");
  const success = page.getByRole("status").filter({ hasText: "Request received for private review" });
  await expect(success).toBeVisible();
  await expect(success).toBeFocused();

  await gotoPublicPage(page, "/request-part");
  const privateSentinel = "WP11_ACCESSIBILITY_PRIVATE_VALUE_SENTINEL";
  await page.locator("#request-brand").fill(privateSentinel);
  await Promise.all([
    page.waitForURL(/\/api\/v1\/submissions\/requests$/u),
    page.locator("form").evaluate((form) => (form as HTMLFormElement).submit()),
  ]);
  expect(await page.locator("body").textContent()).not.toContain(privateSentinel);
  const error = page.getByRole("alert");
  await expect(error).toContainText("Contribution not queued");
  await expect(error).toBeFocused();
  await assertVisibleFocus(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("catalogue breadcrumbs are linked and expose the current page", async ({ page, baseURL }) => {
  await page.goto("/brands/renderworks/rx-100");
  const modelBreadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(modelBreadcrumb.getByRole("link", { name: "Home" })).toHaveAttribute("href", `${new URL(baseURL!).origin}/`);
  await expect(modelBreadcrumb).toContainText("RX-100");

  await page.goto("/parts/render-rx100-latch-r1");
  const partBreadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(partBreadcrumb.getByRole("link", { name: "Home" })).toHaveAttribute("href", `${new URL(baseURL!).origin}/`);
  await expect(partBreadcrumb).toContainText("Dust-bin latch");
});

test("mobile layouts avoid horizontal overflow and honor reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const path of ["/", "/search?q=RX100", "/brands/renderworks/rx-100", "/parts/render-rx100-latch-r1", "/request-part"]) {
    await gotoPublicPage(page, path);
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(metrics.overflow, `${path} has horizontal overflow`).toBeLessThanOrEqual(1);
    expect(metrics.scrollBehavior).toBe("auto");
  }
});

async function gotoPublicPage(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("main")).toBeVisible();
}

async function tabTo(page: Page, selector: string, limit = 35): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const matches = await page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector);
    if (matches) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${selector}.`);
}

async function assertVisibleFocus(page: Page): Promise<void> {
  const outline = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return { style: "none", width: 0 };
    const computed = getComputedStyle(element);
    return { style: computed.outlineStyle, width: Number.parseFloat(computed.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
}
