# Production search

WP-06 keeps search inside PostgreSQL and separates candidate retrieval from
deterministic ranking. All current corpus records are explicitly fictional.

## Public document boundary

Migration `0003_production_search` creates the materialized
`public_search_documents` view; forward migration `0004_repair_search_view`
replaces it without rewriting migration history. WP-07 migration
`0005_production_public_catalogue` replaces it forward again and sources both
model and part documents from the production catalogue eligibility view. A model document requires a published model and
brand. A part document additionally requires a published, current-ruleset
fitment; an accepted exact-model component mapping; a published and available
design; and a current low-risk safety review. Candidate, disputed, rejected,
needs-review, archived, stale-ruleset, caution, and blocked records are absent.

The view stores display text separately from strict and loose identifier arrays.
It also contains component common names for synonym matching. Publication,
evidence moderation, and archive transactions refresh the view before commit.
Anonymous database roles receive `SELECT` on the view, never on its source
tables.

## Ranking and ambiguity

`src/domain/search.ts` is the pure ranking boundary:

1. Brand-scoped strict model identifier
2. Brand-scoped strict OEM identifier
3. Unique formatting-insensitive model/OEM identifier
4. Exact model plus component/common-name match
5. Name or synonym text match
6. Trigram spelling fallback

A model identifier embedded in a compound query is resolved before component,
synonym, text, or trigram ranking. A strict match wins before brand-scoped loose
matching. More than one surviving strict or loose entity returns
`MODEL_AMBIGUOUS` or `OEM_AMBIGUOUS`; ambiguous candidates all receive score
zero, the unconsumed component query is retained, and the client must ask the
user to choose. Affiliate,
sponsorship, and commercial metadata are not search inputs.

## API

`GET /api/v1/search?q=&limit=&cursor=` is the versioned public contract.
`q` must contain at least two characters. `limit` defaults to 20 and is capped
at 50. Results sort by score descending, title, then entity ID. The opaque
base64url cursor records that final tuple; malformed or stale cursors return
`INVALID_CURSOR` rather than silently restarting.

The response contains `results`, an optional `ambiguity`, and
`page.nextCursor`. An empty result continues to the private missing-part path.
Search pages and API responses remain non-indexable under the existing robots
policy.

## Corpus and performance

`tests/fixtures/search-corpus-v1.ts` contains 100 fixed fictional exact
model/OEM queries and a separate loose-collision set. The gate requires at
least 95% exact first-place accuracy and 100% ambiguity detection; the current
corpus passes 100% of both. Component synonym, typo fallback, meaningful leading
zero, cursor, invalid-input, and zero-authority ambiguity behavior have direct
tests.

The launch scope is only 100–200 public records, so the repository reads a
bounded maximum of 250 publication-filtered documents and ranks them in the pure
domain layer. GIN indexes cover strict/loose arrays and trigram text. The launch
gate still requires measured p95 latency below 300 ms using the final dataset;
that claim is deliberately not made from fictional fixtures.

`DEMO_MODE=true` retains the fictional in-memory presentation data. The
database-backed adapter activates only when the eventual release process
explicitly sets `DEMO_MODE=false` after every launch gate passes.
