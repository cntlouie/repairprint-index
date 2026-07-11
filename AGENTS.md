# Instructions for RepairPrint builders

Read `docs/00_START_HERE.md` and the work package assigned to you before changing code.

## Product invariants

1. Fitment belongs to one exact design revision and one exact product model.
2. Safety and fitment are separate decisions. “Fits” never means “safe.”
3. A machine-generated suggestion has zero verification authority.
4. Shared OEM numbers or dimensions can create a candidate, never a verified fit.
5. One accepted exact-model incompatibility report opens a dispute.
6. A print failure is not a fit failure.
7. Product suffixes, regions, revisions, and serial breaks must not be silently merged.
8. Every public factual claim retains source provenance.
9. V0 links to original repository landing pages and does not mirror design files or repository images.
10. No public submission auto-publishes.
11. Low-risk external parts are the only publishable v0 safety class.
12. Affiliate value and sponsorship never influence compatibility rank.

## Development rules

- Keep judgment in pure functions under `src/domain/` and cover it with table-driven tests.
- Preserve source display values; store separate strict and loose search keys.
- Make imports idempotent and resumable. Imported data becomes a candidate, not public content.
- Every schema change includes a migration, data dictionary update, and fresh-database test.
- Every public record change writes an audit event.
- Never place service-role, database, storage, or source API secrets in client code.
- Never fetch arbitrary user-provided URLs. Source adapters use an allowlist.
- Archive records and retain redirects/evidence history; do not casually hard-delete.
- Do not weaken `robots` behavior for demo, candidate, disputed, empty, search, form, or admin pages.

## Required checks

Before marking a work package complete:

```bash
npm run typecheck
npm run lint
npm run test
npm run content:check
npm run build
```

Add database, Playwright, accessibility, and publication-audit gates as their work packages land.

## Stop conditions

Stop and ask for an explicit product decision if a change would:

- Host or transform downloadable 3D files
- Crawl a source without a current permitted ingestion policy
- Add commerce, a marketplace, print fulfilment, or user-to-user messaging
- Publish caution/blocked parts
- Expose user-submitted photos or personal information
- Change confidence/safety rules without a ruleset version and migration plan
- Merge ambiguous models or OEM parts
