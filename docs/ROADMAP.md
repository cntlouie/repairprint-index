# Roadmap and launch gates

The sequence below assumes one lead builder with AI-agent help and a part-time data/editorial track. It is an execution order, not a promise of calendar speed. A focused MVP is roughly 10–14 weeks; evidence collection may be the pacing item.

## Phase 0 — Validate supply and freeze the language (1–2 weeks)

### Build/data

- Assemble a fixed 100-query corpus across vacuum brands
- Audit real availability, source rights, model ambiguity, and discovery quality
- Score candidate brands by useful-design density
- Choose the five launch brands from evidence
- Freeze controlled vocabularies for component synonyms, safety signals, fit outcomes, licence states, and statuses
- Manually create 20 end-to-end records using the proposed schema
- Review source policies and obtain permissions where needed

### Gate P0

- At least 40 of 100 queries reveal a plausible existing printable solution or repeated unmet demand
- At least three brands have sufficient depth for useful model pages
- Twenty sample records fit the schema without free-text relationship hacks
- No launch plan depends on blocked/unsupported scraping
- Confidence and safety rules are signed off and versioned

If the design supply is too thin, narrow to the strongest single brand or change category before building further.

## Phase 1 — Production foundation and internal data platform (2–3 weeks)

### Build

- Production/staging environments and protected CI
- Apply schema migrations and role model
- Invite-only staff authentication and MFA
- Admin CRUD and moderation queues
- CSV dry-run/commit importer
- Duplicate/collision detection
- Evidence/source/citation capture
- Rights and safety review gates
- Audit log, archive, and slug history
- Link checker and stale-source queue

### Gate P1

- An editor can move one source from discovery to reviewed draft without developer help
- A reviewer can accept/reject evidence, safety, and publication independently
- Every material edit produces an audit event
- Publication transaction returns deterministic failure codes
- Fresh database migration and seed tests pass

## Phase 2 — Public search and contribution MVP (3–4 weeks)

### Build

- Replace demo catalogue with published PostgreSQL views/queries
- Identifier interpreter and model disambiguation
- Homepage, brand, exact-model, and canonical part templates
- Evidence, source, licence, safety, and print-recipe UI
- Original-source outbound tracking
- Missing-part, design-link, and fit-report submission flows
- Private photo handling with EXIF removal if included at launch
- Methodology, safety, licensing, privacy, corrections, and notice/takedown pages
- Canonicals, robots, sitemap, structured data, and redirects
- Analytics, error monitoring, rate limiting, and abuse protection

### Gate P2

- Exact-model, exact-OEM, typo, ambiguity, and zero-result journeys work on desktop and mobile
- No anonymous submission writes directly to public tables
- Search p95 is below 300 ms on the launch corpus
- Candidate/disputed/empty/search/form/admin pages are not indexable
- Accessibility critical paths pass keyboard and automated checks

## Phase 3 — Launch dataset and QA (2–4 weeks, parallel where possible)

### Data

- 25–30 model families normalized
- 100–200 useful design revisions indexed
- At least 30 independent exact-model physical verifications
- All regional/suffix collisions resolved or deliberately queued
- Every public record has live source, attribution, rights state, evidence, safety review, and dates

### QA

- Run the fixed query corpus and capture rank results
- Audit source links and creator attribution
- Review every sitemap URL
- Conduct performance, accessibility, privacy, security, and restore checks
- Complete specialist review of legal policies and product claims

### Launch gate P3

- ≥95% top-result accuracy on known exact identifiers
- Zero silent wrong-model resolution
- 100% publication-invariant audit pass
- ≥98% live outbound links
- Zero blocked/caution safety records in the public index
- Zero mirrored files or unlicensed images
- Database restore drill completed
- Named person owns safety/takedown inbox and response process

## Phase 4 — First 90 days

### Weekly

- Review zero-result and ambiguity searches
- Merge duplicate missing-part requests
- Moderate new evidence and disputes
- Recheck broken sources
- Add the densest requested models
- Check Search Console coverage and crawl behavior

### Monthly

- Re-run the fixed query corpus
- Inspect confirmed-repair and negative-fit rates
- Audit confidence changes by ruleset version
- Re-score expansion candidates
- Publish only records that pass the full gate

Do not expand beyond vacuum cleaners until the request-to-research-to-confirmation loop is working.

## Phase 5 — Conditional expansion

Recommended next categories:

1. Dishwasher/refrigerator clips, wheels, handles, knobs, and drawer hardware
2. Low-risk workshop-tool knobs, feet, dust adapters, and external retainers
3. Discontinued electronics cosmetic/mechanical parts after a separate safety review

Only then evaluate model-label OCR, visual similarity, saved equipment, creator dashboards, or a dedicated search service. Commerce and file hosting require an entirely separate legal/product-liability workstream.

## Kill or pivot signals

- Fewer than roughly 30–40 useful existing designs appear in the 100-query audit
- Exact-model mappings cannot be established without systematic extraction prohibited by source terms
- Negative fit evidence is too common to moderate economically
- Users mostly request unique CAD creation rather than discoverable existing files
- Traffic lands on generic “3D print” terms instead of model/OEM repair intent

The likely pivot is not “build a generic STL search engine.” It is to deepen the best-supported brand/category or turn repeated missing demand into a carefully bounded maker-request product later.
