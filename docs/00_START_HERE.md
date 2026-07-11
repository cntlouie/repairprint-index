# Start here: the RepairPrint Index build brief

## The business in one sentence

RepairPrint Index helps a person with a broken appliance or tool find a printable replacement that fits the exact product they own, and shows why that compatibility claim should be trusted.

The useful product is not the STL file. It is the structured fitment and evidence layer currently missing between product labels, OEM catalogues, scattered repository listings, and real-world repair outcomes.

## Decisions already made

| Decision | V0 answer |
| --- | --- |
| First category | Vacuum cleaners |
| Public audience | People repairing their own equipment; no account required |
| Launch wedge | Low-risk clips, latches, knobs, retainers, covers, feet, and external adapters |
| Core entity | Design revision × exact model × physical component fitment |
| File policy | Link to original creator landing page; do not host files |
| Evidence | Human-reviewed, source-backed, deterministic labels |
| Search | Exact/normalized identifiers first; PostgreSQL fuzzy text second |
| AI role | Discovery and extraction assistant only; never verifier |
| User content | Private moderation queue; nothing auto-publishes |
| Geography | English/global site operated from Iceland; obtain EU/Iceland legal review before launch |
| Monetization | Affiliate alternatives and ads later; never alter ranking by revenue |

## Definition of the launch product

The public MVP is ready only when it has:

- 5 vacuum brands chosen by real design density, not brand fame
- 25–30 exact model families, with regional/suffix variants represented correctly
- 100–200 useful original-source design links
- At least 30 independently verified exact-model fitments
- Exact model/OEM search and safe model disambiguation
- Model and canonical part pages with visible evidence, print notes, rights data, and source links
- Missing-part, fit-report, and design-link submissions
- An authenticated moderation workflow, audit history, and broken-link checks
- Public methodology, safety, licensing, privacy, correction, and notice/takedown pages

Every published record must have a live original landing page, creator, licence state (including `NOT-STATED`), exact compatibility wording, source retrieval/last-check dates, safety review, and evidence record.

## The four hard boundaries

1. **No unsafe catalogue expansion.** Publish only low-risk v0 parts.
2. **No fake verification.** AI, dimensions, family similarity, and OEM cross-references remain candidates until actual fit evidence exists.
3. **No rights shortcut.** Link to original landing pages; do not copy files, thumbnails, descriptions, or diagrams without specific rights.
4. **No thin SEO factory.** Candidate-only, empty, request, search, and duplicate pages stay out of search indexes.

## First 48 hours for the build team

1. Create the production repository and copy this bootstrap into it.
2. Protect `main`; require the CI gate.
3. Create staging and production PostgreSQL projects and a preview deployment.
4. Keep `DEMO_MODE=true` everywhere except a locked local test of the public query layer.
5. Run work package WP-00 and record any deviation in `docs/DECISION_LOG.md`.
6. Start Phase 0 data validation in parallel; do not wait for the UI.
7. Review the source and legal guardrails before writing an ingestion adapter.

## Who does what

| Role | Responsibility |
| --- | --- |
| Product owner | Scope, taxonomy decisions, go/no-go gates, source permissions |
| Data researcher/editor | Normalization, provenance, candidate records, source checks |
| Reviewer | Fit evidence, safety, licence state, publication approval |
| Builder | Application, database, imports, admin, search, tests, deployment |
| AI agent | Candidate discovery, structured extraction, collision flags, repetitive implementation |

One person may hold several roles, but a public claim must still pass the review state machine.

## Handoff outcome

The project should emerge from the work packages as a small editorial data platform with a public search surface—not as a repository scraper. That is the smallest version capable of building the defensible compatibility graph.
