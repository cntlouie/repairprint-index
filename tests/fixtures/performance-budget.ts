export const PUBLIC_PERFORMANCE_BUDGET = Object.freeze({
  documentBytes: 180_000,
  javascriptBytes: 550_000,
  thirdPartyRequests: 0,
  cumulativeLayoutShift: 0.05,
  responseStartMilliseconds: 1_000,
  domContentLoadedMilliseconds: 2_500,
});

export const PERFORMANCE_ROUTES = Object.freeze([
  ["homepage", "/"],
  ["search", "/search?q=RX-100"],
  ["exact model", "/brands/renderworks/rx-100"],
  ["canonical part", "/parts/render-rx100-latch-r1"],
] as const);
