# Public performance budget

**Status:** WP-11 engineering gate, last reviewed 2026-07-13.

The gate measures a warmed production build with a 390 × 844 Chromium viewport
against the deterministic fictional PostgreSQL verification corpus. It covers the homepage,
one exact search, one exact-model page, and one canonical-part page. Each route
uses a fresh browser context so JavaScript delivery is not hidden by another
route's browser cache.

| Measure | Budget | Reason |
| --- | ---: | --- |
| Decompressed HTML/document | 180,000 bytes per route | Keeps each server-rendered public route bounded; launch-volume capacity still requires a separate load review. |
| Decompressed first-party JavaScript | 550,000 bytes per route | Caps the complete Next.js/React runtime plus route code with less than 6% headroom over the measured 520,362-byte framework baseline. |
| Third-party requests | 0 | Public catalogue routes need no third-party runtime; analytics remains first-party and non-blocking. |
| Cumulative Layout Shift | ≤ 0.05 | Leaves a conservative margin below the usual “good” boundary. |
| Warm response start | ≤ 1,000 ms | Reproducible local-CI response budget after one warm-up request. |
| DOM content loaded | ≤ 2,500 ms | Conservative mobile-oriented render budget on the deterministic CI host. |

The accepted WP-11 local reference run on 2026-07-13 measured:

| Route | Document bytes | JavaScript bytes | Third-party requests | CLS | DOM content loaded | Response start |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 23,849 | 520,362 | 0 | 0 | 109.2 ms | 10.2 ms |
| `/search?q=RX-100` | 14,238 | 521,235 | 0 | 0 | 27.3 ms | 12.2 ms |
| `/brands/renderworks/rx-100` | 21,436 | 520,362 | 0 | 0 | 29.7 ms | 14.4 ms |
| `/parts/render-rx100-latch-r1` | 35,091 | 521,235 | 0 | 0 | 121.5 ms | 17.3 ms |

`tests/browser/wp11-performance.spec.ts` records every measured baseline as a
`WP11_PERFORMANCE_BASELINE` JSON line before enforcing the thresholds. Baseline
values in the WP-11 pull-request report come from the exact head verified in CI.
The thresholds are source-controlled in
`tests/fixtures/performance-budget.ts`; changing them requires an explicit
performance review, not an automatic update from a failing run.

The gate measures transferred route resources and layout behavior; it is not a
claim about real-user Core Web Vitals or production network latency. Those
require a separately reviewed production-observation decision. No analytics
provider, performance beacon, cookie, or third-party script is introduced by
this work package.
