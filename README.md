# RepairPrint Index bootstrap

This repository is a builder-ready starting point for an evidence-backed index of 3D-printable replacement parts.

The product promise is deliberately narrow:

> Enter an exact product model or OEM part number and find printable replacements that fit it, with visible evidence, safety context, creator attribution, and a link to the original source.

RepairPrint Index is not an STL host, generic model search engine, marketplace, or AI-generated-parts service. Its durable asset is the graph connecting:

`exact product model → physical component/OEM part → design revision → fitment evidence`

## What is already included

- A polished responsive Next.js homepage and core public page scaffold
- Search, exact-model, part, missing-request, fit-report, and design-submission flows
- A PostgreSQL/Drizzle schema and generated first migration
- Deterministic fitment, safety, identifier-normalization, and publication rules
- Versioned submission/search endpoints
- Fictional seed data that cannot be mistaken for a real compatibility claim
- Crawler blocking while `DEMO_MODE` is enabled
- Unit tests, content checks, linting, strict TypeScript, and a production build gate
- A complete product, data, safety, legal, SEO, roadmap, and builder work package

The public UI currently reads from `src/lib/demo-data.ts`. The first production data work package replaces that demo repository with PostgreSQL queries and reviewed launch records.

## Quick start

Requirements: Node.js 22+ and npm. PostgreSQL is optional for the visual demo.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

Run the full local gate:

```bash
npm run check
```

The gate also verifies the WP-00 bootstrap contract and scans tracked/unignored
source files for common credential formats. Environment provisioning and required
repository controls are recorded in
[`docs/ENVIRONMENT_INVENTORY.md`](docs/ENVIRONMENT_INVENTORY.md).

For database work:

```bash
docker compose up -d db
npm run db:migrate
npm run db:seed
```

The seed is fictional and remains unpublished.

## Production target

- Next.js App Router monolith
- Managed PostgreSQL (Supabase is the recommended default)
- Drizzle for typed CRUD; hand-written PostgreSQL for identifier search
- PostgreSQL `pg_trgm` plus exact normalized keys for v0 search
- Invite-only staff authentication; no public accounts in v0
- Private object storage only when photo submissions are added
- Vercel or an equivalent Node-compatible host

Do not add a separate search service, vector database, microservices, file hosting, or marketplace until measured demand requires it.

## Read in this order

1. [Start here](docs/00_START_HERE.md)
2. [Product blueprint](docs/PRODUCT_BLUEPRINT.md)
3. [Roadmap](docs/ROADMAP.md)
4. [Builder work packages](docs/BUILDER_WORK_PACKAGES.md)
5. [Technical architecture](docs/TECHNICAL_ARCHITECTURE.md)
6. [Data and ingestion](docs/DATA_AND_INGESTION.md)
7. [Trust, safety, and moderation](docs/TRUST_SAFETY_AND_MODERATION.md)
8. [Legal and rights guardrails](docs/LEGAL_AND_RIGHTS_GUARDRAILS.md)
9. [SEO and analytics](docs/SEO_AND_ANALYTICS.md)
10. [Acceptance tests](docs/ACCEPTANCE_TESTS.md)
11. [Operations runbook](docs/OPERATIONS_RUNBOOK.md)
12. [Environment inventory](docs/ENVIRONMENT_INVENTORY.md)

`AGENTS.md` contains the non-negotiable rules for coding agents. `docs/BUILDER_HANDOFF_PROMPT.md` can be pasted directly into a builder-agent conversation.

## Current status

This is a verified bootstrap, not a production launch. The application compiles and the pure domain rules are tested, but the real dataset, admin authentication, private media workflow, production queries, rate limiting, monitoring, and legal review remain gated work.

Never switch `DEMO_MODE=false` until every launch gate in `docs/ACCEPTANCE_TESTS.md` passes.
