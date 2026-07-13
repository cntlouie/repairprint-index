import { expect, test } from "@playwright/test";

import { PERFORMANCE_ROUTES, PUBLIC_PERFORMANCE_BUDGET as budget } from "../fixtures/performance-budget";

declare global {
  interface Window { __repairPrintCumulativeLayoutShift?: number }
}

for (const [label, path] of PERFORMANCE_ROUTES) {
  test(`${label} stays within the public mobile-oriented performance budget`, async ({ browser, baseURL, request }) => {
    await request.get(path);
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__repairPrintCumulativeLayoutShift = 0;
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
          if (!entry.hadRecentInput) window.__repairPrintCumulativeLayoutShift! += entry.value ?? 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    const canonicalOrigin = new URL(baseURL!).origin;
    const thirdParty = new Set<string>();
    const scripts = new Map<string, Promise<number>>();
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (url.origin !== canonicalOrigin) thirdParty.add(url.origin);
    });
    page.on("response", (response) => {
      if (response.request().resourceType() !== "script") return;
      const url = response.url();
      if (!url.startsWith(canonicalOrigin) || scripts.has(url)) return;
      scripts.set(url, response.body().then((body) => body.byteLength));
    });

    const documentResponse = await page.goto(new URL(path, baseURL).toString(), { waitUntil: "load" });
    expect(documentResponse).not.toBeNull();
    await page.waitForTimeout(750);
    const documentBytes = (await documentResponse!.body()).byteLength;
    const javascriptBytes = (await Promise.all(scripts.values())).reduce((sum, size) => sum + size, 0);
    const browserMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return {
        cumulativeLayoutShift: window.__repairPrintCumulativeLayoutShift ?? 0,
        domContentLoadedMilliseconds: navigation.domContentLoadedEventEnd - navigation.startTime,
        responseStartMilliseconds: navigation.responseStart - navigation.startTime,
      };
    });
    const measured = {
      route: path,
      documentBytes,
      javascriptBytes,
      thirdPartyRequests: thirdParty.size,
      ...browserMetrics,
    };
    console.log(`WP11_PERFORMANCE_BASELINE ${JSON.stringify(measured)}`);

    expect(documentBytes).toBeLessThanOrEqual(budget.documentBytes);
    expect(javascriptBytes).toBeLessThanOrEqual(budget.javascriptBytes);
    expect(thirdParty.size).toBeLessThanOrEqual(budget.thirdPartyRequests);
    expect(browserMetrics.cumulativeLayoutShift).toBeLessThanOrEqual(budget.cumulativeLayoutShift);
    expect(browserMetrics.responseStartMilliseconds).toBeLessThanOrEqual(budget.responseStartMilliseconds);
    expect(browserMetrics.domContentLoadedMilliseconds).toBeLessThanOrEqual(budget.domContentLoadedMilliseconds);
    await context.close();
  });
}
