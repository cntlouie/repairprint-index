import { expect, test, type Page, type Route } from "@playwright/test";

import { browserAnalyticsEventSchema, type BrowserAnalyticsEvent } from "@/domain/analytics";

test("search analytics emits only bounded classifications and never the raw query", async ({ page }) => {
  const events = await captureAnalytics(page);

  await page.goto("/search?q=RX-100", { waitUntil: "networkidle" });
  await expectEvent(events, "search_submitted");
  const exactResult = page.locator(".result-list a").first();
  await expect(exactResult).toBeVisible();
  await exactResult.click();
  await expectEvent(events, "search_resolved");

  await page.goto("/search?q=RX100", { waitUntil: "networkidle" });
  await expectEvent(events, "variant_disambiguation_shown");
  await clickWithoutNavigation(page, ".result-list a");
  await expectEvent(events, "variant_selected");

  await page.goto("/search?q=NO-MATCH-999", { waitUntil: "networkidle" });
  await expectEvent(events, "zero_result");

  for (const event of events) expect(browserAnalyticsEventSchema.safeParse(event).success).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/RX-100|RX100|NO-MATCH-999|search_term|referrer|user.?agent|email|serial/iu);
  const propertyKeys = events.flatMap((event) => Object.keys(event.properties))
    .map((key) => key.replace(/[^a-z]/giu, "").toLocaleLowerCase("en"));
  for (const forbidden of ["query", "rawquery", "searchterm", "referrer", "useragent", "email", "serial"]) {
    expect(propertyKeys).not.toContain(forbidden);
  }
});

test("part interactions use only published IDs and bounded public context", async ({ page, context }) => {
  const events = await captureAnalytics(page);
  await page.goto("/parts/render-rx100-latch-r1", { waitUntil: "networkidle" });
  await expectEvent(events, "part_viewed");

  await clickWithoutNavigation(page, 'a.button-primary[href^="https://render.example/"]');
  await expectEvent(events, "original_source_clicked");
  await clickWithoutNavigation(page, 'a[href^="/confirm-fit?part="]');
  await expectEvent(events, "fit_report_started");

  for (const event of events) expect(browserAnalyticsEventSchema.safeParse(event).success).toBe(true);
  const serialized = JSON.stringify(events);
  expect(serialized).toContain("fit_render_live_r1");
  expect(serialized).not.toMatch(/https?:|RX-100|Render Fixture Creator|CC-BY|cookie|storage|fingerprint/iu);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
});

async function captureAnalytics(page: Page): Promise<BrowserAnalyticsEvent[]> {
  const events: BrowserAnalyticsEvent[] = [];
  await page.route("**/api/v1/analytics/events", async (route: Route) => {
    const candidate = route.request().postDataJSON() as unknown;
    const parsed = browserAnalyticsEventSchema.safeParse(candidate);
    if (parsed.success) events.push(parsed.data);
    await route.fulfill({
      body: JSON.stringify({ accepted: true }),
      contentType: "application/json",
      status: 202,
    });
  });
  return events;
}

async function expectEvent(
  events: readonly BrowserAnalyticsEvent[],
  name: BrowserAnalyticsEvent["name"],
): Promise<void> {
  await expect.poll(() => events.some((event) => event.name === name)).toBe(true);
}

async function clickWithoutNavigation(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { once: true });
    (element as HTMLElement).click();
  });
}
