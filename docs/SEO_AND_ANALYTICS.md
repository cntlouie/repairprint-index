# SEO, discovery, and analytics

RepairPrint’s SEO advantage should come from uniquely useful exact-model fitment data, not page volume.

## Indexability formula

An exact-model or canonical part page may be indexed only when it has:

```text
published exact model
+ low-risk approved safety review
+ at least one Creator Listed-or-better live design
+ visible creator/source/licence/evidence/last-check data
+ unique repair or compatibility information
+ self-canonical URL
```

Keep these `noindex,follow` or blocked:

- Search and parameterized filter pages
- Candidate-only and disputed/rejected pages
- Models with no real solution
- Unresolved requests and submission forms
- Thin design metadata pages
- Admin, preview, staging, and demo pages

The implementation blocks all crawling unless `DEMO_MODE` is exact `false`,
`NODE_ENV` and any provider environment are production, the separate
`REPAIRPRINT_DEPLOYMENT_ENV` marker is exact `production`, the configured site
URL is one strict HTTPS origin (loopback HTTP is test-only), and a reviewed
HTTPS notice channel exists. Missing or malformed inputs fail closed. Preview
and staging markers remain blocked even if another variable is wrong.

## Page requirements

### Exact model page

- Exact label identifier and aliases/region distinctions
- Guidance for confirming the model
- Real indexed components, grouped by physical part
- Per-design fitment labels
- Last material update
- Links to methodology and request path

### Canonical part page

- Broken component name and location/context
- OEM/alias/supersession data with visible sources
- Exact models and separate status for each revision/model edge
- Evidence explanation and accepted reports
- Creator, original landing page, licence state, revision, and last check
- Sourced print recipe and required hardware
- Safety boundary and failure consequence
- OEM/aftermarket alternative where useful
- Fit-report action

Do not repeat a repository description as the primary copy. Explain the fitment and evidence RepairPrint uniquely knows.

## Canonicals, redirects, and sitemaps

- Stable, readable slugs backed by stable IDs internally
- One permanent redirect (HTTP 308 in the Next.js implementation) from every recorded old path
- One self-canonical public URL per page
- Sitemap only for 200, indexable, self-canonical pages
- `lastmod` only after a material public-data change
- Split sitemaps by entity type once volume needs it
- Search/filter URLs never enter the sitemap

Material dates are derived from publication, accepted-claim review, live-source
retrieval/check, rights review, safety review, accepted evidence, and reviewed
recipe timestamps. Generic record `updated_at` values are deliberately excluded
because an internal or unrendered field change must not move public `lastmod`.

Run an automated sitemap audit before every release.

## Structured data

Use only facts visible on the page:

- `WebSite` with a real search action on the homepage
- `BreadcrumbList` on catalogue pages
- `CollectionPage` for category/brand/model collections
- `CreativeWork` or Schema.org `3DModel` for enriched design information when accurate
- `HowTo` only when RepairPrint supplies a complete genuine procedure

Never manufacture ratings, reviews, prices, availability, FAQs, or OEM endorsement. Structured data does not make thin content useful.

## Query coverage

Target repair intent such as:

```text
[brand] [exact model] [component]
[OEM part number] 3D print
[exact model] replacement latch
[exact model] printable wheel clip
```

Component synonyms and label variants belong in structured data/search keys, not repetitive keyword paragraphs.

## Analytics events

| Event | Required properties |
| --- | --- |
| `search_submitted` | normalized category, query length, identifier-like flag |
| `search_resolved` | entity type, match class, rank, ambiguity count |
| `variant_disambiguation_shown` | candidate count |
| `variant_selected` | selected rank; never serial/PII |
| `zero_result` | normalized token class, optional brand/category |
| `part_viewed` | public ID, confidence tier, safety class |
| `original_source_clicked` | design/fitment public ID, source platform, confidence tier |
| `fit_report_started/submitted` | public ID, outcome on submit |
| `missing_part_submitted` | matched/unmatched category; no email/model label text in analytics |
| `design_submitted` | source platform classification |

Keep emails, label photos, serial numbers, free text, and exact private identifiers out of analytics.

WP-11 stores no raw event rows. A dedicated least-privilege database function
increments one bounded categorical counter per UTC day after validating the
exact event-specific property tuple and any referenced public catalogue ID.
The table constraint is explicitly two-valued: every required property must be
present, non-null, correctly typed and in range; optional properties must meet
the same non-null/type rules whenever present; and unknown keys fail. The
execute-only function returns fixed error codes without echoing submitted
dimensions, and a rejected public reference rolls back its tentative increment.
The browser endpoint is same-origin, size bounded, cookie-free and best effort.
Successful contribution events are scheduled after the response only for a
genuinely new private queue write; idempotent retries do not increment them and
analytics latency cannot delay the accepted submission. `ANALYTICS_MODE=disabled` is
the repository and deployment default, and no analytics provider or credential
is provisioned.

After product/privacy owners choose a retention horizon and operations
provisions an authorized reporting role, a private small-cell-suppressed report
can be run with
`npm run analytics:report -- --days=30 --minimum-cell-count=5`. The report
refuses anonymous and analytics-service roles and exposes neither raw events
nor per-day cells. Follow the credential separation and private-output procedure
in `docs/OPERATIONS_RUNBOOK.md`; the report credential is read-only, is not the
web application's `DATABASE_URL`, and is never configured in the deployment.

## First 90 days

Weekly:

- Review zero-result and ambiguity logs
- Check source click-through by confidence tier
- Turn repeated missing demand into data tasks
- Check crawl/index anomalies in Search Console
- Fix broken sources and misleading snippets

Useful early targets:

- ≥95% fixed-corpus exact top-result accuracy
- ≥25% original-source click-through from eligible part pages
- ≥98% live source links
- Rising resolved-search rate
- Candidate-to-confirmed conversion growing
- Wrong-model incidents at zero

Do not measure progress by page count. Measure successful exact matches and confirmed repairs.

## Monetization guardrails

- Original creator/source link is the primary action.
- Clearly label OEM/aftermarket/filament/tool affiliate links.
- Add `rel="sponsored"` to paid/affiliate destinations.
- Ads and offers cannot move confidence or compatibility rank.
- Do not place aggressive ads beside safety warnings or evidence labels.
