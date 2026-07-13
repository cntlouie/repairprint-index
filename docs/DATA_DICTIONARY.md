# Database data dictionary

This dictionary describes migrations `0000_curvy_shinko_yamashiro`,
`0001_fixed_jack_murdock`, `0002_dizzy_magik`, and
`0003_production_search`, `0004_repair_search_view`,
`0005_production_public_catalogue`, `0006_anonymous_contributions`,
`0007_private_media`, `0008_motionless_thunderbolt`, and
`0009_source_adapters_link_health`, `0010_wp10_corrective_boundaries`,
`0011_wp10_acl_recovery`, and `0012_eager_earthquake`. The schema
contains fictional demo data only until the publication work packages and
release gates are complete.

## Conventions

- Internal primary keys are UUIDs. Stable URLs and APIs use explicit
  non-sequential `public_id` values where present.
- `created_at` and `updated_at` are timezone-aware. Application writers must
  update `updated_at`; PostgreSQL does not do that automatically.
- Display identifiers are retained exactly. `strict_key` retains meaningful
  punctuation; `loose_key` is an additional search key and never proves entity
  equivalence.
- Publication status is separate from moderation, fitment confidence, and
  safety. None of those fields may substitute for another.
- `fitment-v1` and `safety-v1` are the active deterministic rulesets. Stale
  computed versions fail the publication gate; migration and recomputation are
  documented in `docs/RULESET_MIGRATION.md`.
- Archive and evidence history are retained. Foreign-key deletion behavior is
  restrictive unless the child has no independent evidentiary value.

## Enumerations

| Enum | Values | Meaning |
| --- | --- | --- |
| `publication_status` | `draft`, `in_review`, `published`, `needs_review`, `archived` | Public lifecycle; only an explicit publication transaction may select `published` |
| `moderation_status` | `pending`, `accepted`, `rejected` | Editorial decision on evidence or mappings |
| `safety_class` | `low`, `caution`, `blocked` | Independent failure-consequence class; only `low` is publishable in v0 |
| `fitment_status` | `verified_fit`, `community_confirmed`, `creator_listed`, `candidate_match`, `disputed`, `rejected` | Versioned confidence result for one exact fitment edge |
| `fit_outcome` | `fits_without_modification`, `fits_after_modification`, `does_not_fit`, `print_failed`, `unsure` | Observation result; `print_failed` is not a fit failure |
| `evidence_kind` | `trusted_physical_test`, `community_report`, `creator_claim`, `oem_mapping`, `dimensional_match`, `editorial_note` | Provenance-aware evidence category |
| `source_policy` | `api`, `creator_submission`, `written_permission`, `link_only`, `blocked` | Current permitted ingestion policy |
| `submission_kind` | `missing_part`, `fit_confirmation`, `design_submission`, `rights_or_safety_notice` | Private intake queue category |
| `submission_status` | `pending`, `in_review`, `accepted`, `rejected`, `resolved` | Semantic moderation-parent lifecycle; acceptance does not auto-publish |
| `submission_email_status` | `pending`, `processing`, `sent`, `failed`, `cancelled` | Private event-created follow-up lifecycle; consent alone creates no row and only a qualifying match/moderator event may create `pending` work |
| `staff_role` | `editor`, `reviewer`, `admin` | Server-authorized permissions; reviewer/admin require AAL2 MFA |
| `staff_status` | `invited`, `active`, `disabled` | Invite-only lifecycle; only active profiles authorize staff actions |
| `import_run_status` | `committed`, `failed` | Durable result of an attributed candidate-import operation |
| `import_row_status` | `candidate`, `ambiguous`, `rejected`, `unchanged` | Private import disposition; none grants publication authority |
| `import_collision_type` | `duplicate_external_item`, `model_ambiguous`, `part_number_ambiguous`, `supersession_cycle` | Human-resolution queue category |
| `import_collision_status` | `open`, `resolved` | Collision review lifecycle; resolution requires a later attributed action |
| `source_ingestion_stage` | `discovered`, `fetched`, `parsed`, `normalized`, `ambiguous`, `safety_screened`, `review_ready`, `approved`, `rejected` | Private, optimistic candidate state machine; terminal approval still grants no publication authority |
| `source_candidate_origin` | `adapter`, `manual`, `creator_submission` | Private candidate intake boundary |
| `source_adapter_run_status` | `running`, `completed`, `failed` | Durable, idempotent adapter-run result |
| `source_link_job_status` | `pending`, `leased` | Database-clock link-check lease state |

## Tables

| Table | Purpose | Identity and important constraints | Retention / publication notes |
| --- | --- | --- | --- |
| `brands` | Canonical manufacturer identity | UUID PK; unique `slug` and `normalized_name` | Has independent `publication_status` |
| `categories` | Product/component hierarchy | UUID PK; unique `slug`; nullable `parent_id` reserved for hierarchy | Reference data; archive through dependent records rather than casual deletion |
| `product_models` | One exact product model, region/revision-aware | UUID PK; unique `public_id`; unique `(brand_id, slug)`; restrictive brand/category FKs | Exact models must never be silently merged; `published_at` accompanies publication |
| `product_identifiers` | Sourced label/model identifiers | UUID PK; unique `(product_model_id, display_value)`; indexed strict and loose keys | Preserve `display_value`; `source_citation_id` is provenance metadata pending the reviewed polymorphic-link follow-on |
| `components` | Human physical-part concepts | UUID PK; unique `(category_id, slug)`; restrictive category FK | Concepts do not prove OEM or fitment equivalence |
| `oem_parts` | Manufacturer part identifiers | UUID PK; unique `public_id`; unique `(brand_id, strict_part_key)`; loose key indexed | Shared numbers create candidates only; publication is independent |
| `oem_part_supersessions` | Cited directed OEM relationships | Composite PK `(from_part_id, to_part_id)`; both FKs cascade with the OEM records | A row is not valid without cited evidence; ambiguous supersessions stop for review |
| `product_components` | Component/OEM mapping for one exact model and optional serial range | UUID PK; unique `(product_model_id, component_id, oem_part_id)`; model cascades, component restricts, OEM sets null | `mapping_status` is moderation only; serial breaks remain explicit |
| `creators` | Design creator identity on a platform | UUID PK; unique `(platform, display_name)` | `external_profile_url` links to the source profile; no public account implied |
| `source_platform_policies` | Allowlisted ingestion/rights policy | Platform PK; reviewed terms checksum; explicit globally bounded allowed fields and reuse/automation flags | Disabled, stale, mismatched or non-current policy blocks adapters; file/image rehosting is always false |
| `source_policy_reviews` | Immutable human legal/policy review snapshot | Unique platform/version; 64-hex terms checksum; exact field allowlist; reviewer FK and bounded expiry | Update/delete/truncate rejected; automated checks cannot renew approval |
| `source_adapter_runs` | Private adapter invocation ledger | Unique public run ID and deterministic input fingerprint; policy/actor/request attribution | Exact retry reuses the run; sanitized failure codes only |
| `source_candidates` | Private platform item identity | Unique `(platform, external_id)` with origin and staff creator | Never creates a source, fitment, safety, rights or publication decision |
| `source_candidate_versions` | Private checksum-versioned candidate payload | Unique `(candidate_id, content_checksum)`; checksum collisions require byte-equivalent canonical payload | Changed content creates a fresh review state; old evidence is not transferred |
| `source_candidate_acquisitions` | Immutable provenance edge for every private acquisition | Unique acquisition fingerprint and adapter-run association; exact origin, policy review, run, actor, request and retrieval attribution | Exact retries reuse an edge; another run, origin or policy retains a separate edge to the content version |
| `sources` | Original evidence/source landing pages | UUID PK; unique `canonical_url`; status index | Retain provenance and link-check history; v0 links rather than mirrors |
| `source_citations` | Field-level factual provenance | UUID PK; source FK restricts; indexed `(entity_type, entity_id)` | Polymorphic claim target; pending review is not publication authority |
| `designs` | Creator work independent of source revisions | UUID PK; unique `public_id` and `slug`; creator FK restricts | Availability and publication are separate; archive rather than delete |
| `design_revisions` | Immutable source revision and rights snapshot | UUID PK; unique `(design_id, source_revision)`; design cascades, source restricts | Fitment belongs to this exact revision; stores licence and attribution evidence |
| `fitments` | One design revision × one exact product component | UUID PK; unique `public_id`, `slug`, and `(design_revision_id, product_component_id)`; both FKs restrict | Confidence is versioned; `publication_status` and `published_at` are separate |
| `fitment_evidence` | Moderated observations for a fitment edge | UUID PK; fitment FK cascades; citation sets null; indexed fitment/status | Exact model and revision flags stay explicit; one accepted incompatibility can open a dispute |
| `safety_reviews` | Independent component failure-consequence review | UUID PK; unique `(product_component_id, ruleset_version)`; component mapping cascades | Safety never derives from fitment confidence; v0 publication requires `low` |
| `print_recipes` | Print settings for a fitment | UUID PK; unique `fitment_id`; fitment cascades; citation sets null | Print success/failure remains separate from fit outcome |
| `submissions` | Private semantic moderation queue | UUID PK plus separate unique opaque `receipt_id`; version-one parents carry the HMAC framing version plus hashed semantic contributor/content keys; active `(kind, hmac_version, contributor_key, content_fingerprint)` uniqueness | Version-one `payload` is only the canonical semantic projection used for moderation/demand deduplication. Intake-specific wording, notes, legal state, contact and deadlines live on immutable child intakes. A parent and its receipt survive while any child intake remains; no accepted submission auto-publishes. Legacy rows remain version 0. |
| `submission_idempotency_bindings` | Private immutable accepted intakes and durable retry bindings | UUID PK; unique `(kind, idempotency_actor_key, idempotency_key_hash)` scope; composite FK fixes the semantic parent, endpoint, intake/HMAC version and receipt; checks cover HMAC digests, required consent, challenge and independent deadlines | Every accepted UUID stores its own complete payload, consent/policy snapshot, acceptance/challenge timestamps, contact-presence/digest state and retention deadlines. Semantic aliases may share one parent/receipt but never overwrite or borrow another intake's data. Database triggers reject updates/truncation and permit deletion only through already-expired maintenance cleanup. |
| `submission_intake_contacts` | Expiring private contact for one immutable intake | `intake_id` PK; composite FK requires a contact-present intake with the same digest; contact/email checks; immutable mutation triggers | The normalized email is separate so cleanup can remove it at its own deadline without rewriting the intake's accepted legal snapshot. No public or ordinary authenticated role can read it. |
| `submission_hmac_key_pin` | Private singleton HMAC key commitment | Singleton boolean PK; unique algorithm/framing version; 64-hex purpose-separated commitment; provision timestamp | Stores a commitment, never the secret. Production intake verifies it before deriving identities or writing. The submission service has SELECT only; owner/admin provisioning is explicit and replacement is refused while dependent records remain. |
| `submission_rate_limit_buckets` | Durable serverless anonymous-write limiter | Composite PK `(scope, subject_hash, window_started_at, window_seconds)`; positive count/window/expiry checks; atomic capped upsert | Stores only window-scoped HMAC subjects, never raw network addresses; expired rows are opportunistically removed |
| `submission_email_follow_ups` | Qualifying-event future-contact work | UUID PK; restrictive composite intake/submission FK; unique `follow_up_key`; constrained event/template pair plus lease/sent checks | No consent-time row exists. A typed match/moderator event must revalidate the exact intake's current consent, live contact and both deadlines before creating `pending` work. WP-08 adds no provider, worker or sender. |
| `private_media_upload_sessions` | One private photo capability for one exact immutable intake and purpose | Unpredictable public ID/path; unique `(intake_id, purpose)`; restrictive exact `(intake_id, kind)` FK; separate upload and finalize capability expiries; processing and cleanup leases | Receipt or semantic parent alone never selects media; three purposes bind each exact intake to at most three photos. Cleanup cannot shorten an advertised finalize capability, and every application transition rejects an active cleanup lease. |
| `private_media_consents` | Immutable per-photo rights/privacy decision | Session PK plus exact-intake FK; separate ownership, private storage, derivative processing and public-display decisions; versioned policies/deadline | Public display defaults false and is never inferred. Only retention maintenance can delete. |
| `private_media_assets` | Private decoded source facts and moderation state | One asset/session; intake-scoped checksum uniqueness; byte/dimension/pixel checks | Checksums never deduplicate or link different intakes. |
| `private_media_derivatives` | Private metadata-free review copies | Unique `(asset, kind)` and unpredictable path; WebP checksum/size/dimensions | Sanitized master, thumbnail and manual redaction remain private in WP-09. |
| `private_media_pending_objects` | Durable deletion manifest for private objects written before their database record commits | Unique object path; session FK; derivative kind; database-clock cleanup deadline and lease | Written before storage upload and removed only in the transaction that commits the derivative. A crash or failed compensation leaves a bounded, deletion-first cleanup record. |
| `private_media_redactions` | Manual rectangle-redaction history | Unique asset/version; rectangles plus hash; staff/reason/derivative FKs | No automatic face recognition or inferred rectangles. |
| `source_link_checks` | Append-only source availability and bounded-content observations | UUID PK; source FK cascades; indexed `(source_id, checked_at)`; optional 64-hex response checksum | Removal, restriction, material redirect or content checksum change can move public claims to `needs_review`; retain check history |
| `source_link_check_jobs` | Bounded resumable link-health work | One row/source; database-clock due time; token/owner/expiry lease invariant | `SKIP LOCKED` claims permit concurrent workers and expired leases are reclaimable |
| `private_analytics_daily_aggregates` | Private privacy-bounded daily product-usage totals | Composite PK `(event_day, event_name, dimensions)`; allowlisted event names; an event-specific JSON shape check rejects unknown keys, raw query/contact/media fields, malformed public IDs, and out-of-range categories/counts | Stores one UTC-day counter per bounded dimension tuple, never raw event rows, request timestamps, cookies, IP/user-agent/referrer data, or private contribution values. Public catalogue IDs occur only in the documented part/source/fit-report events and are checked against the publication-filtered catalogue by the recorder. No aggregate retention horizon or live provider has been approved, so runtime collection remains disabled unless production receives an explicit reviewed configuration. |
| `slug_history` | Redirect history for renamed/archived public paths | UUID PK; unique `old_path` | Retain redirects; never silently reuse an old path for another entity |
| `audit_log` | Immutable privileged-change evidence | UUID PK; required staff actor, reason, request ID; indexed `(entity_type, entity_id, created_at)` | Database triggers reject update, delete, and truncate |
| `staff_profiles` | Supabase Auth identity to RepairPrint staff role mapping | UUID PK; unique auth user UUID and email; self-referencing inviter; reviewer/admin MFA check | Invite-only; disabled profiles retain historical audit attribution |
| `import_runs` | Attributed checksum-locked CSV commit | UUID PK; unique public ID and input checksum; restrictive actor FK; required report/reason/request ID | Repeating an input returns the existing run; retain operational history |
| `import_rows` | Normalized private candidate payloads | UUID PK; unique global idempotency key and `(run, file, row)`; restrictive run FK | Candidate/ambiguous/rejected states are never public content |
| `import_collisions` | Model/OEM/URL/supersession review queue | UUID PK; restrictive run/row/staff FKs; unique `(row, type, key)`; indexed open queue | Never auto-resolve or merge an ambiguous entity |

## Anonymous database views

`published_brands`, `published_product_models`, `published_designs`, and
`published_fitments` are legacy security-barrier views retained for internal
compatibility. Their status-only predicates are not the complete WP-07
publication boundary, so migration `0005` revokes `anon`/`authenticated` access
to them. Those roles can read only the safe catalogue, tombstone, and search
relations below; all base tables remain inaccessible. The staging public Data
API remains disabled.

`public_search_documents` is the denormalized materialized search view added by
migration `0003` and replaced forward by migration `0004` to correct its
display delimiter without rewriting applied history. Migration `0005` replaces
it again so search and catalogue pages share the same publication-eligibility
boundary. It exposes published exact-model documents and only
low-risk, current-ruleset, publication-eligible fitment documents. Display
identifiers remain separate from strict/loose keys; component synonyms are
included as search terms. Loose collisions are deliberately resolved by the
application ambiguity gate rather than by the view. Publication, dispute, and
archive transactions refresh it before commit; GIN indexes support identifier
arrays and trigram text fallback.

`public_catalogue_fitments` is the WP-07 security-barrier view. It exposes one
row per exact design revision × exact model fitment only when publication,
confidence, evidence, provenance, source-policy, source-health, rights, target,
safety, notice, and current-ruleset gates all pass. `source_type = 'demo'` is
always excluded. Exact model names, primary identifiers, and product-component
mappings require matching accepted citations from eligible sources; uncited
aliases and other optional factual fields are omitted. Canonical slugs are
computed only across rows that pass this same complete predicate.
`public_catalogue_unavailable_sources` exposes a deliberately
minimal, non-indexable tombstone for a previously published record whose source
or design became unavailable while every other public gate still passes. It
does not expose the removed URL, evidence details, or private submissions.

Migration `0006` does not add any anonymous view. `submissions`, immutable
intake bindings, intake contacts, the HMAC key pin, rate buckets, and follow-up
work are server-only base tables with explicit revocations for `anon` and
`authenticated`. Runtime private operations use the separately credentialed
`repairprint_submission_service` role and fail closed if the connection has a
different database identity or the configured key does not match the singleton
pin. The service can select/insert only the reviewed intake relations, mutate
only rate-bucket counters, and execute the bounded cleanup function; it cannot
update or directly delete an intake/contact or change the key pin. Cleanup runs
as the separate no-login `repairprint_submission_maintenance` function owner,
uses database time, and can delete only expired private rows. Public
catalogue/search views do not select contact, consent, challenge,
deduplication, receipt, or queue fields.

Migrations `0007` and `0008` add no anonymous view. All media tables and cleanup functions
are revoked from `PUBLIC`, `anon`, and `authenticated`. Media paths, exact
intake IDs, consent, moderation and retention fields are absent from every
public catalogue/search relation.

Migrations `0009` and `0010` add no anonymous view. Policy snapshots, adapter runs,
candidates, candidate versions/acquisitions, link leases and detailed check history are
revoked from `PUBLIC`, `anon` and `authenticated`. Runtime source operations
use the separately credentialed `repairprint_source_service`, which owns no
tables and can execute only candidate-transition and link claim/completion
functions. State-changing functions run as the isolated no-login
`repairprint_source_maintenance` owner. Confirmed removal uses the documented
citation dependency map, marks supported published dependants `needs_review`,
refreshes search in the same transaction and records machine-attributed audit
evidence.

Migration `0011` repairs function ACLs from their owning maintenance-role
context. Migration `0012` adds no anonymous view and grants no public analytics
access. `private_analytics_daily_aggregates` is explicitly revoked from
`PUBLIC`, `anon`, and `authenticated`. The login-capable
`repairprint_analytics_service` owns no relation and has no direct table or
sequence privileges; it can execute only
`record_private_analytics_event(text,jsonb)`. That security-definer function is
owned by the no-login `repairprint_analytics_maintenance` role, fixes its
`search_path` to `pg_catalog`, validates catalogue-backed dimension tuples, and
atomically increments the UTC daily aggregate. Application configuration is
fail-closed in demo mode, for unknown modes, and when its separately
credentialed database URL is absent. Analytics does not participate in search
ranking, fitment, safety, moderation, or publication decisions.
`scripts/report-private-analytics.ts` is an operator-only, read-only report for
zero-result, ambiguity, and matched-demand aggregates; it combines the selected
window, suppresses cells below a configurable minimum (five by default), and
refuses anonymous or analytics-service database identities.

## Migration integrity

- Canonical migrations: `drizzle/0000_curvy_shinko_yamashiro.sql`,
  `drizzle/0001_fixed_jack_murdock.sql`, `drizzle/0002_dizzy_magik.sql`, and
  `drizzle/0003_production_search.sql`, and
  `drizzle/0004_repair_search_view.sql`, and
  `drizzle/0005_production_public_catalogue.sql`, and
  `drizzle/0006_anonymous_contributions.sql`, and
  `drizzle/0007_private_media.sql`, and
  `drizzle/0008_motionless_thunderbolt.sql`, and
  `drizzle/0009_source_adapters_link_health.sql`, and
  `drizzle/0010_wp10_corrective_boundaries.sql`, and
  `drizzle/0011_wp10_acl_recovery.sql`, and
  `drizzle/0012_eager_earthquake.sql`.
- Canonical schema source: `src/db/schema.ts`.
- `npm run db:generate` must report no drift unless a reviewed schema change is
  intentionally being prepared.
- Every schema change must include a generated migration, this dictionary, a
  migration-specific recovery note, and the fresh-database test.
