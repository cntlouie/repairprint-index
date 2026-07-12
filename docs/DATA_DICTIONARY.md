# Database data dictionary

This dictionary describes migrations `0000_curvy_shinko_yamashiro`,
`0001_fixed_jack_murdock`, `0002_dizzy_magik`, and
`0003_production_search`, and `0004_repair_search_view`. The schema
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
| `submission_status` | `pending`, `in_review`, `accepted`, `rejected`, `resolved` | Intake workflow state; acceptance does not auto-publish |
| `staff_role` | `editor`, `reviewer`, `admin` | Server-authorized permissions; reviewer/admin require AAL2 MFA |
| `staff_status` | `invited`, `active`, `disabled` | Invite-only lifecycle; only active profiles authorize staff actions |
| `import_run_status` | `committed`, `failed` | Durable result of an attributed candidate-import operation |
| `import_row_status` | `candidate`, `ambiguous`, `rejected`, `unchanged` | Private import disposition; none grants publication authority |
| `import_collision_type` | `duplicate_external_item`, `model_ambiguous`, `part_number_ambiguous`, `supersession_cycle` | Human-resolution queue category |
| `import_collision_status` | `open`, `resolved` | Collision review lifecycle; resolution requires a later attributed action |

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
| `source_platform_policies` | Allowlisted ingestion/rights policy | Platform PK; explicit allowed fields and reuse/automation flags | Disabled or stale policy blocks adapters; file/image rehosting defaults false |
| `sources` | Original evidence/source landing pages | UUID PK; unique `canonical_url`; status index | Retain provenance and link-check history; v0 links rather than mirrors |
| `source_citations` | Field-level factual provenance | UUID PK; source FK restricts; indexed `(entity_type, entity_id)` | Polymorphic claim target; pending review is not publication authority |
| `designs` | Creator work independent of source revisions | UUID PK; unique `public_id` and `slug`; creator FK restricts | Availability and publication are separate; archive rather than delete |
| `design_revisions` | Immutable source revision and rights snapshot | UUID PK; unique `(design_id, source_revision)`; design cascades, source restricts | Fitment belongs to this exact revision; stores licence and attribution evidence |
| `fitments` | One design revision × one exact product component | UUID PK; unique `public_id`, `slug`, and `(design_revision_id, product_component_id)`; both FKs restrict | Confidence is versioned; `publication_status` and `published_at` are separate |
| `fitment_evidence` | Moderated observations for a fitment edge | UUID PK; fitment FK cascades; citation sets null; indexed fitment/status | Exact model and revision flags stay explicit; one accepted incompatibility can open a dispute |
| `safety_reviews` | Independent component failure-consequence review | UUID PK; unique `(product_component_id, ruleset_version)`; component mapping cascades | Safety never derives from fitment confidence; v0 publication requires `low` |
| `print_recipes` | Print settings for a fitment | UUID PK; unique `fitment_id`; fitment cascades; citation sets null | Print success/failure remains separate from fit outcome |
| `submissions` | Private anonymous/staff intake queue | UUID PK; indexed `(status, kind, created_at)` | Payload may contain personal data; no accepted submission auto-publishes |
| `source_link_checks` | Append-only source availability observations | UUID PK; source FK cascades; indexed `(source_id, checked_at)` | Changes can move public claims to `needs_review`; retain check history |
| `slug_history` | Redirect history for renamed/archived public paths | UUID PK; unique `old_path` | Retain redirects; never silently reuse an old path for another entity |
| `audit_log` | Immutable privileged-change evidence | UUID PK; required staff actor, reason, request ID; indexed `(entity_type, entity_id, created_at)` | Database triggers reject update, delete, and truncate |
| `staff_profiles` | Supabase Auth identity to RepairPrint staff role mapping | UUID PK; unique auth user UUID and email; self-referencing inviter; reviewer/admin MFA check | Invite-only; disabled profiles retain historical audit attribution |
| `import_runs` | Attributed checksum-locked CSV commit | UUID PK; unique public ID and input checksum; restrictive actor FK; required report/reason/request ID | Repeating an input returns the existing run; retain operational history |
| `import_rows` | Normalized private candidate payloads | UUID PK; unique global idempotency key and `(run, file, row)`; restrictive run FK | Candidate/ambiguous/rejected states are never public content |
| `import_collisions` | Model/OEM/URL/supersession review queue | UUID PK; restrictive run/row/staff FKs; unique `(row, type, key)`; indexed open queue | Never auto-resolve or merge an ambiguous entity |

## Anonymous database views

`published_brands`, `published_product_models`, `published_designs`, and
`published_fitments` are security-barrier views that expose only records whose
publication status is `published`. When Supabase `anon`/`authenticated` roles
exist, migration `0001` revokes their access to the corresponding base tables
and grants read access only to these views. The staging public Data API remains
disabled.

`public_search_documents` is the denormalized materialized search view added by
migration `0003` and replaced forward by migration `0004` to correct its
display delimiter without rewriting applied history. It exposes published exact-model documents and only
low-risk, current-ruleset, publication-eligible fitment documents. Display
identifiers remain separate from strict/loose keys; component synonyms are
included as search terms. Loose collisions are deliberately resolved by the
application ambiguity gate rather than by the view. Publication, dispute, and
archive transactions refresh it before commit; GIN indexes support identifier
arrays and trigram text fallback.

## Migration integrity

- Canonical migrations: `drizzle/0000_curvy_shinko_yamashiro.sql`,
  `drizzle/0001_fixed_jack_murdock.sql`, `drizzle/0002_dizzy_magik.sql`, and
  `drizzle/0003_production_search.sql`, and
  `drizzle/0004_repair_search_view.sql`.
- Canonical schema source: `src/db/schema.ts`.
- `npm run db:generate` must report no drift unless a reviewed schema change is
  intentionally being prepared.
- Every schema change must include a generated migration, this dictionary, a
  migration-specific recovery note, and the fresh-database test.
