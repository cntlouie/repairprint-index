# Production public catalogue

WP-07 replaces the bootstrap demo arrays with server-only PostgreSQL reads.
`DEMO_MODE` still blocks crawlers and production reads, but it no longer causes
fictional product records to appear. Fictional catalogue data lives only in
explicit fixtures and the guarded development/test seed.

## Public eligibility boundary

Migration `0005_production_public_catalogue` creates
`public_catalogue_fitments`. A row represents exactly one design revision × one
exact product component/model. It is visible only when all of these remain
true at query time:

- fitment, design, exact model, and brand are published;
- fitment status is Verified, Community Confirmed, or Creator Listed and its
  accepted evidence still deterministically supports that stored status;
- no accepted exact-revision incompatibility exists;
- fitment and safety rulesets are current;
- the exact component mapping is accepted and any OEM record is published;
- the safety review is current, independently reviewed, and low-risk;
- the original source is live, non-demo, and covered by a current permitted
  platform policy;
- creator, revision, attribution, licence and accepted claim provenance exist;
- no open rights or safety notice targets the design or fitment.

The materialized search view is rebuilt from this same view, so public pages and
search cannot disagree about publication eligibility.

## Page query behavior

- Exact-model pages query by both brand slug and exact model slug, then query
  solutions by the resulting model UUID. No family or loose identifier is used
  to expand fitments.
- A part lookup starts from one eligible fitment slug and groups only eligible
  rows for the same design and physical component. Every model/revision edge
  retains its own label, evidence, source/rights snapshot, recipe and safety
  review.
- Private `submissions.payload` is never selected. Design submission notes are
  not reused as public page copy.
- A formerly published record whose landing page or design becomes unavailable
  disappears from listings/search and receives a minimal `noindex` tombstone.
  The removed URL and private evidence are not exposed.
- Slug history is resolved to its final safe internal destination before one
  permanent HTTP redirect is issued. Cycles and external targets fail closed.

## Caching and invalidation

Reads use `catalogue:all`, `catalogue:index`, exact-model, and part-slug cache
tags with a bounded revalidation interval. Successful publication, evidence
moderation, and archive endpoints invalidate the index plus every exact-model
and part slug in the affected design/component group. Future source-health jobs
must call the same invalidation boundary when they change source availability.
